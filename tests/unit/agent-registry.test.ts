import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentRegistry } from "../../src/core/agents/agent-registry.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("AgentRegistry", () => {
    let testDir: string;

    beforeEach(() => {
        AgentRegistry._resetForTesting();
        testDir = mkdtempSync(path.join(tmpdir(), "oco-agents-test-"));
    });

    afterEach(() => {
        try {
            rmSync(testDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
        AgentRegistry._resetForTesting();
    });

    it("initializes with built-in agents", () => {
        const registry = AgentRegistry.getInstance();
        const agents = registry.listAgents();
        expect(agents).toContain("Commander");
        expect(agents).toContain("Planner");
        expect(agents).toContain("Worker");
        expect(agents).toContain("Reviewer");

        const commander = registry.getAgent("Commander");
        expect(commander).toBeDefined();
        expect(commander?.id).toBe("Commander");
        expect(commander?.canWrite).toBe(true);
    });

    it("registers new agents dynamically", () => {
        const registry = AgentRegistry.getInstance();
        registry.registerAgent("CustomAuditor", {
            id: "custom_auditor",
            description: "Custom audit agent",
            systemPrompt: "You are an auditor",
            canWrite: false,
            canBash: false,
        });

        expect(registry.listAgents()).toContain("CustomAuditor");
        const auditor = registry.getAgent("CustomAuditor");
        expect(auditor?.description).toBe("Custom audit agent");
    });

    it("loads custom agents from .opencode/agents.json including comments and trailing commas", async () => {
        const opencodeDir = path.join(testDir, ".opencode");
        mkdirSync(opencodeDir, { recursive: true });

        const jsoncContent = `
        {
            // Custom tester agent definition
            "Tester": {
                "id": "tester",
                "description": "Automated test specialist",
                "systemPrompt": "Run and maintain tests",
                "canWrite": true,
                "canBash": true, // trailing comma here
            },
            // Another invalid agent to test schema rejection
            "InvalidAgent": {
                "id": "invalid",
                // missing description and flags
            }
        }
        `;

        writeFileSync(path.join(opencodeDir, "agents.json"), jsoncContent, "utf8");

        const registry = AgentRegistry.getInstance();
        registry.setDirectory(testDir);
        await registry.ready();

        expect(registry.listAgents()).toContain("Tester");
        expect(registry.listAgents()).not.toContain("InvalidAgent");
        const tester = registry.getAgent("Tester");
        expect(tester?.id).toBe("tester");
        expect(tester?.description).toBe("Automated test specialist");
    });

    it("handles missing .opencode/agents.json gracefully", async () => {
        const registry = AgentRegistry.getInstance();
        registry.setDirectory(testDir);
        await registry.ready();

        expect(registry.listAgents()).toContain("Commander");
    });

    describe("host agents", () => {
        function hostClient(data: unknown, fail = false) {
            return {
                app: {
                    agents: async () => {
                        if (fail) throw new Error("host unreachable");
                        return { data };
                    },
                },
            };
        }

        it("registers host-defined agents and marks them as host-owned", async () => {
            const registry = AgentRegistry.getInstance();
            await registry.loadHostAgents(hostClient([
                { id: "subagent", description: "Executes one delegated subtask", system: "HOST SYSTEM" },
            ]));

            expect(registry.listAgents()).toContain("subagent");
            expect(registry.getAgent("subagent")?.description).toBe("Executes one delegated subtask");
            expect(registry.getAgent("subagent")?.systemPrompt).toBe("HOST SYSTEM");
            expect(registry.isHostAgent("subagent")).toBe(true);
        });

        it("never shadows a built-in agent", async () => {
            const registry = AgentRegistry.getInstance();
            await registry.loadHostAgents(hostClient([{ id: "Commander", system: "HOST SYSTEM" }]));

            expect(registry.getAgent("Commander")?.systemPrompt).not.toBe("HOST SYSTEM");
            expect(registry.isHostAgent("Commander")).toBe(false);
        });

        it("does not mark agents.json roles as host-owned", async () => {
            const registry = AgentRegistry.getInstance();
            registry.registerAgent("LocalRole", {
                id: "LocalRole", description: "d", systemPrompt: "p", canWrite: true, canBash: true,
            });
            await registry.loadHostAgents(hostClient([{ id: "LocalRole" }]));

            expect(registry.isHostAgent("LocalRole")).toBe(false);
            expect(registry.getAgent("LocalRole")?.systemPrompt).toBe("p");
        });

        it("skips the host's hidden system stages, which are not delegable roles", async () => {
            const registry = AgentRegistry.getInstance();
            await registry.loadHostAgents(hostClient([
                { id: "subagent_reverse", system: "HOST SYSTEM" },
                { id: "title", system: "HOST SYSTEM", hidden: true },
                { id: "compaction", system: "HOST SYSTEM", hidden: true },
            ]));

            expect(registry.isHostAgent("subagent_reverse")).toBe(true);
            expect(registry.getAgent("title")).toBeUndefined();
            expect(registry.getAgent("compaction")).toBeUndefined();
        });

        it("survives a host that cannot list its agents", async () => {
            const registry = AgentRegistry.getInstance();
            await registry.loadHostAgents(hostClient([], true));

            expect(registry.listAgents()).toContain("Commander");
            expect(registry.listAgents()).toHaveLength(4);
        });

        it("survives a client without an app endpoint", async () => {
            const registry = AgentRegistry.getInstance();
            await registry.loadHostAgents({});

            expect(registry.listAgents()).toHaveLength(4);
        });
    });

    describe("refreshing host agents", () => {
        /**
         * The host merges the user's `agent:` config after plugin setup, so the
         * first list is a snapshot that a later one can legitimately extend.
         */
        function mutableHostClient() {
            let listed: unknown[] = [{ id: "build", system: "HOST BUILD SYSTEM" }];
            let calls = 0;
            return {
                calls: () => calls,
                set: (next: unknown[]) => { listed = next; },
                client: {
                    app: {
                        agents: async () => {
                            calls += 1;
                            return { data: listed };
                        },
                    },
                },
            };
        }

        it("registers an agent the host added after the startup list", async () => {
            const host = mutableHostClient();
            const registry = AgentRegistry.getInstance();
            await registry.loadHostAgents(host.client);

            expect(registry.isHostAgent("subagent_reverse")).toBe(false);

            host.set([{ id: "build" }, { id: "subagent_reverse", system: "HOST SYSTEM" }]);
            await registry.refreshHostAgents();

            expect(registry.isHostAgent("subagent_reverse")).toBe(true);
            expect(registry.getAgent("subagent_reverse")?.systemPrompt).toBe("HOST SYSTEM");
        });

        it("drops a host agent the host no longer lists", async () => {
            const host = mutableHostClient();
            const registry = AgentRegistry.getInstance();
            await registry.loadHostAgents(host.client);
            host.set([{ id: "build" }, { id: "subagent_browser", system: "HOST SYSTEM" }]);
            await registry.loadHostAgents(host.client);

            expect(registry.isHostAgent("subagent_browser")).toBe(true);

            host.set([{ id: "build" }]);
            await registry.refreshHostAgents();

            expect(registry.isHostAgent("subagent_browser")).toBe(false);
            expect(registry.getAgent("subagent_browser")).toBeUndefined();
            expect(registry.getAgent("Commander")).toBeDefined();
        });

        it("keeps host routes when a refresh gets no usable answer", async () => {
            const host = mutableHostClient();
            const registry = AgentRegistry.getInstance();
            await registry.loadHostAgents(host.client);
            host.set([{ id: "build" }, { id: "subagent_browser", system: "HOST SYSTEM" }]);
            await registry.loadHostAgents(host.client);

            host.set([]);
            await registry.refreshHostAgents();

            // An unreachable host must not coerce every delegation to Commander.
            expect(registry.isHostAgent("subagent_browser")).toBe(true);
        });

        it("shares one list between concurrent refreshes", async () => {
            const host = mutableHostClient();
            const registry = AgentRegistry.getInstance();
            await registry.loadHostAgents(host.client);
            const callsAfterLoad = host.calls();

            await Promise.all([registry.refreshHostAgents(), registry.refreshHostAgents(), registry.refreshHostAgents()]);

            expect(host.calls()).toBe(callsAfterLoad + 1);
        });

        it("does not re-list for a name the plugin already defines", async () => {
            const host = mutableHostClient();
            const registry = AgentRegistry.getInstance();
            registry.registerAgent("LocalRole", {
                id: "LocalRole", description: "d", systemPrompt: "p", canWrite: true, canBash: true,
            });
            await registry.loadHostAgents(host.client);
            const callsAfterLoad = host.calls();

            expect(await registry.resolveHostAgent("LocalRole")).toBe(false);
            expect(await registry.resolveHostAgent("Commander")).toBe(false);

            expect(host.calls()).toBe(callsAfterLoad);
        });

        it("re-lists once for a name the plugin does not know at all", async () => {
            const host = mutableHostClient();
            const registry = AgentRegistry.getInstance();
            await registry.loadHostAgents(host.client);
            const callsAfterLoad = host.calls();

            expect(await registry.resolveHostAgent("subagent_reverse")).toBe(false);
            expect(host.calls()).toBe(callsAfterLoad + 1);

            host.set([{ id: "build" }, { id: "subagent_reverse", system: "HOST SYSTEM" }]);
            expect(await registry.resolveHostAgent("subagent_reverse")).toBe(true);
            expect(await registry.resolveHostAgent("subagent_reverse")).toBe(true);
            // Settled on the second call: the third answer needs no list.
            expect(host.calls()).toBe(callsAfterLoad + 2);
        });
    });
});
