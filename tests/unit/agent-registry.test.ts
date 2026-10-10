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
});
