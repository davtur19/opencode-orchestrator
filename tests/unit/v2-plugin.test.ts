import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Plugin } from "@opencode/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import OrchestratorPlugin from "../../src/index.js";

describe("OpenCode 2 plugin setup", () => {
    const directories: string[] = [];

    afterEach(() => {
        for (const directory of directories.splice(0)) {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("registers native V2 agents, tools, commands, hooks, and cleanup", async () => {
        const directory = mkdtempSync(path.join(tmpdir(), "oco-v2-test-"));
        directories.push(directory);
        const registrations: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
        const agents = new Map<string, { id: string; description?: string; system?: string; mode: string; hidden: boolean }>();
        const tools: Array<{ name?: string }> = [];
        const commands: Array<{ name?: string }> = [];
        const hookNames: string[] = [];
        const registration = () => {
            const value = { dispose: vi.fn().mockResolvedValue(undefined) };
            registrations.push(value);
            return Promise.resolve(value);
        };
        const context = {
            location: { directory, project: { directory } },
            options: {},
            agent: {
                list: vi.fn().mockResolvedValue([]),
                transform: vi.fn((callback: (editor: { update: (id: string, edit: (agent: NonNullable<ReturnType<typeof agents.get>>) => void) => void }) => void) => {
                    callback({ update: (id, edit) => {
                        const agent = agents.get(id) ?? { id, mode: "all", hidden: false };
                        edit(agent);
                        agents.set(id, agent);
                    } });
                    return registration();
                }),
            },
            session: {
                create: vi.fn(), prompt: vi.fn(), synthetic: vi.fn(), interrupt: vi.fn(), context: vi.fn(),
                hook: vi.fn((name: string) => { hookNames.push(`session.${name}`); return registration(); }),
            },
            tool: {
                transform: vi.fn((callback: (editor: { add: (tool: { name?: string }) => void }) => void) => {
                    callback({ add: tool => tools.push(tool) });
                    return registration();
                }),
                hook: vi.fn((name: string) => { hookNames.push(`tool.${name}`); return registration(); }),
            },
            command: {
                transform: vi.fn((callback: (editor: { add: (command: { name?: string }) => void }) => void) => {
                    callback({ add: command => commands.push(command) });
                    return registration();
                }),
            },
            event: { subscribe: () => emptyEvents() },
        } as unknown as Plugin.Context;

        const cleanup = await OrchestratorPlugin.setup(context);

        expect([...agents.keys()]).toEqual(["Commander", "Planner", "Worker", "Reviewer"]);
        expect(agents.get("Commander")).toMatchObject({ mode: "primary", hidden: false, system: expect.any(String) });
        expect(agents.get("Commander")?.system).toContain("You are Commander.");
        expect(agents.get("Commander")?.system).toContain("historical context, not a new user request or approval");
        for (const name of ["Planner", "Worker", "Reviewer"]) {
            expect(agents.get(name)).toMatchObject({ mode: "subagent", hidden: true, system: expect.any(String) });
            expect(agents.get(name)?.system).toContain(`You are ${name}.`);
        }
        expect(tools.some(tool => tool.name === "delegate_task")).toBe(true);
        expect(commands.map(command => command.name)).toEqual(expect.arrayContaining([
            "task", "plan", "agents", "stop", "cancel",
        ]));
        expect(hookNames).toEqual(expect.arrayContaining([
            "session.prompt", "session.context", "session.compaction",
            "tool.execute.before", "tool.execute.after",
        ]));
        expect(cleanup).toBeTypeOf("function");
        await cleanup?.();
        expect(registrations.every(item => item.dispose.mock.calls.length === 1)).toBe(true);
    });

    /**
     * Register the plugin's V2 commands against a stub context and return the
     * registered `task` command together with the session spies.
     */
    async function registerTaskCommand(options?: Record<string, unknown>) {
        const directory = mkdtempSync(path.join(tmpdir(), "oco-v2-command-"));
        directories.push(directory);
        const commands: Array<{ name: string; execute: (input: unknown) => Promise<void> }> = [];
        const context = {
            options: options ?? {},
            session: { prompt: vi.fn().mockResolvedValue(undefined), synthetic: vi.fn().mockResolvedValue(undefined) },
            command: { transform: vi.fn(async (edit: (editor: { add: (command: typeof commands[number]) => void }) => void) => {
                edit({ add: command => commands.push(command) });
                return { dispose: vi.fn() };
            }) },
        } as unknown as Plugin.Context;
        const { registerV2Commands } = await import("../../src/v2/command-adapter.js");
        const { parseOrchestratorPluginOptions } = await import("../../src/core/config/plugin-options.js");
        const handlerContext = { directory, sessions: new Map() } as unknown as Parameters<typeof registerV2Commands>[1];
        await registerV2Commands(context, handlerContext, parseOrchestratorPluginOptions(options as never).messageVisibility);
        return { context, task: commands.find(command => command.name === "task")! };
    }

    // Regression: the host never persists a user message for a slash command
    // (packages/core/src/session/command.ts on the OC2 host), so the only record
    // of what the user typed is what this adapter sends. Sent as `synthetic` it
    // is a message with role `synthetic`, which openchamber drops outright
    // (packages/ui/src/components/chat/lib/timelineRoles.ts SKIPPED_ROLES), and
    // `/task <text>` renders as nothing at all.
    it("delivers task as a visible user prompt by default", async () => {
        const { context, task } = await registerTaskCommand();
        await task.execute({ sessionID: "s1", prompt: { text: "do work" } });
        expect(context.session.prompt).toHaveBeenCalledWith(expect.objectContaining({ sessionID: "s1", text: expect.stringContaining("do work") }));
        expect(context.session.synthetic).not.toHaveBeenCalled();
    });

    it("keeps the legacy hidden delivery when messageVisibility is synthetic", async () => {
        const { context, task } = await registerTaskCommand({ messageVisibility: "synthetic" });
        await task.execute({ sessionID: "s1", prompt: { text: "do work" } });
        expect(context.session.synthetic).toHaveBeenCalledWith(expect.objectContaining({ sessionID: "s1" }));
        expect(context.session.prompt).not.toHaveBeenCalled();
    });

    it("maps the showInjectedMessages boolean alias onto messageVisibility", async () => {
        const hidden = await registerTaskCommand({ showInjectedMessages: false });
        await hidden.task.execute({ sessionID: "s1", prompt: { text: "do work" } });
        expect(hidden.context.session.synthetic).toHaveBeenCalled();
        expect(hidden.context.session.prompt).not.toHaveBeenCalled();

        const shown = await registerTaskCommand({ showInjectedMessages: true });
        await shown.task.execute({ sessionID: "s1", prompt: { text: "do work" } });
        expect(shown.context.session.prompt).toHaveBeenCalled();
        expect(shown.context.session.synthetic).not.toHaveBeenCalled();
    });

    it("falls back to the visible default for an unknown messageVisibility value", async () => {
        const { context, task } = await registerTaskCommand({ messageVisibility: "elsewhere" });
        await task.execute({ sessionID: "s1", prompt: { text: "do work" } });
        expect(context.session.prompt).toHaveBeenCalled();
        expect(context.session.synthetic).not.toHaveBeenCalled();
    });

    it("leaves stop and cancel without any prompt", async () => {
        const { context, task } = await registerTaskCommand();
        await task.execute({ sessionID: "s1", prompt: { text: "do work" } });
        expect(context.session.prompt).toHaveBeenCalledTimes(1);
        expect(context.session.synthetic).not.toHaveBeenCalled();
    });

    it("replaces an active V2 mission after interrupting its owner", async () => {
        const directory = mkdtempSync(path.join(tmpdir(), "oco-v2-replace-"));
        directories.push(directory);
        const commands: Array<{ name: string; execute: (input: unknown) => Promise<void> }> = [];
        const session = {
            prompt: vi.fn().mockResolvedValue(undefined),
            synthetic: vi.fn().mockResolvedValue(undefined),
            interrupt: vi.fn().mockResolvedValue({ interrupted: true }),
        };
        const context = {
            session,
            command: { transform: vi.fn(async (edit: (editor: { add: (command: typeof commands[number]) => void }) => void) => {
                edit({ add: command => commands.push(command) });
                return { dispose: vi.fn() };
            }) },
        } as unknown as Plugin.Context;
        const { createV2ClientBridge } = await import("../../src/v2/client-adapter.js");
        const { registerV2Commands } = await import("../../src/v2/command-adapter.js");
        const { ParallelAgentManager } = await import("../../src/core/agents/manager.js");
        const bridge = createV2ClientBridge(context);
        const manager = vi.spyOn(ParallelAgentManager, "getInstance").mockReturnValue({
            cancelTasksForParent: vi.fn().mockResolvedValue(true),
        } as never);
        try {
            await registerV2Commands(context, { client: bridge.client, directory, sessions: new Map() } as never, "visible");
            const task = commands.find(command => command.name === "task")!;
            await task.execute({ sessionID: "old-root", prompt: { text: "Old mission" } });
            bridge.statuses.set("old-root", "busy");
            await task.execute({ sessionID: "new-root", prompt: { text: "New mission" } });
            expect(session.interrupt).toHaveBeenCalledWith({ sessionID: "old-root", resume: false });
            expect(session.prompt).toHaveBeenLastCalledWith(expect.objectContaining({ sessionID: "new-root" }));
        } finally {
            manager.mockRestore();
        }
    });

    it("applies configured temperature in the V2 generation context", async () => {
        const directory = mkdtempSync(path.join(tmpdir(), "oco-v2-temperature-"));
        directories.push(directory);
        let contextHook: ((input: unknown) => Promise<void>) | undefined;
        const registration = async () => ({ dispose: vi.fn() });
        const context = {
            location: { directory, project: { directory } },
            options: { agentTemperatures: { Commander: 0.1 } },
            agent: { list: vi.fn().mockResolvedValue([]), transform: registration },
            session: { hook: vi.fn((name: string, callback: (input: unknown) => Promise<void>) => {
                if (name === "context") contextHook = callback;
                return registration();
            }) },
            tool: { hook: registration, transform: registration },
            command: { transform: registration },
            event: { subscribe: () => emptyEvents() },
        } as unknown as Plugin.Context;
        const cleanup = await OrchestratorPlugin.setup(context);
        const request = { sessionID: "s1", agent: "Commander", model: { providerID: "p", id: "m" }, system: [], options: { temperature: 0.7 } };
        await contextHook?.(request);
        expect(request.options.temperature).toBe(0.1);
        await cleanup?.();
    });

    it("passes the agent seen in the V2 context hook to later prompt hooks", async () => {
        const directory = mkdtempSync(path.join(tmpdir(), "oco-v2-agent-"));
        directories.push(directory);
        const hooks = new Map<string, (input: unknown) => Promise<void>>();
        const registration = async () => ({ dispose: vi.fn() });
        const context = {
            location: { directory, project: { directory } },
            options: {},
            agent: { list: vi.fn().mockResolvedValue([]), transform: registration },
            session: { hook: vi.fn((name: string, callback: (input: unknown) => Promise<void>) => {
                hooks.set(name, callback);
                return registration();
            }) },
            tool: { hook: registration, transform: registration },
            command: { transform: registration },
            event: { subscribe: () => emptyEvents() },
        } as unknown as Plugin.Context;
        const { HookRegistry } = await import("../../src/hooks/registry.js");
        const cleanup = await OrchestratorPlugin.setup(context);
        const executeChat = vi.spyOn(HookRegistry.getInstance(), "executeChat");
        const sessionID = "ses_v2_agent_memory";
        try {
            // /task creates the orchestrator session state the agent is remembered in.
            await hooks.get("prompt")?.({ sessionID, prompt: { text: "/task Build the feature" } });
            await hooks.get("context")?.({
                sessionID, agent: "Commander", model: { providerID: "p", id: "m" }, system: [], options: {},
            });
            await hooks.get("prompt")?.({ sessionID, prompt: { text: "keep going" } });

            expect(executeChat).toHaveBeenLastCalledWith(
                expect.objectContaining({ sessionID, agent: "commander" }),
                "keep going",
            );
        } finally {
            executeChat.mockRestore();
            await hooks.get("prompt")?.({ sessionID, prompt: { text: "/stop" } });
            await cleanup?.();
        }
    });
});

async function* emptyEvents(): AsyncGenerator<never> {
    return;
}
