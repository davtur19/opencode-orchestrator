import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "../../src/core/agents/agent-registry";
import { buildRoutedAgentPrompt } from "../../src/core/agents/manager/prompt-routing";
import { MemoryLevel, MemoryManager } from "../../src/core/memory/memory-manager";
import { AGENT_NAMES, TOOL_NAMES } from "../../src/shared";

vi.mock("../../src/core/agents/logger", () => ({ log: vi.fn() }));

describe("buildRoutedAgentPrompt", () => {
    beforeEach(() => {
        MemoryManager.getInstance().import({
            [MemoryLevel.SYSTEM]: [],
            [MemoryLevel.PROJECT]: [],
            [MemoryLevel.MISSION]: [],
            [MemoryLevel.TASK]: [],
        });
    });

    it("keeps built-in agents on their own OpenCode agent route", async () => {
        const routed = await buildRoutedAgentPrompt(
            AGENT_NAMES.WORKER,
            "Implement the assigned file",
        );

        expect(routed.wireAgent).toBe(AGENT_NAMES.WORKER);
        expect(routed.text).toBe("Implement the assigned file");
        expect(routed.text).not.toContain("### AGENT ROLE:");
        expect(routed.tools).toEqual({
            [TOOL_NAMES.SKILL]: true,
            [TOOL_NAMES.RUN_COMMAND]: true,
        });
    });

    it("routes a host-defined agent to itself without re-injecting its role prompt when host routing is on", async () => {
        const hostAgent = "subagent_reverse";
        await AgentRegistry.getInstance().loadHostAgents({
            app: { agents: async () => ({ data: [{ id: hostAgent, description: "Reverse-engineering subagent", system: "HOST SYSTEM" }] }) },
        });

        const routed = await buildRoutedAgentPrompt(hostAgent, "Disassemble the loader", true);

        expect(routed.wireAgent).toBe(hostAgent);
        expect(routed.text).toBe("Disassemble the loader");
        expect(routed.text).not.toContain("### AGENT ROLE:");
        expect(routed.text).not.toContain("HOST SYSTEM");
        // Not Commander, so it must not inherit the delegation tools.
        expect(routed.tools).toEqual({
            [TOOL_NAMES.SKILL]: true,
            [TOOL_NAMES.RUN_COMMAND]: true,
        });
    });

    it("falls back to Commander for a host-defined agent when host routing is off", async () => {
        const hostAgent = "subagent_off_mode";
        await AgentRegistry.getInstance().loadHostAgents({
            app: { agents: async () => ({ data: [{ id: hostAgent, description: "Reverse-engineering subagent", system: "HOST SYSTEM" }] }) },
        });

        // The option is opt-in, so the plugin's own delegation surface stands:
        // the name is unknown here and rides on Commander.
        const routed = await buildRoutedAgentPrompt(hostAgent, "Disassemble the loader");

        expect(routed.wireAgent).toBe(AGENT_NAMES.COMMANDER);
        // A host agent runs as a Commander clone: the host applies its own
        // system prompt, so re-injecting it here would double it up.
        expect(routed.text).toBe("Disassemble the loader");
        expect(routed.text).not.toContain("### AGENT ROLE:");
        expect(routed.text).not.toContain("HOST SYSTEM");
        expect(routed.tools).toEqual(expect.objectContaining({
            [TOOL_NAMES.DELEGATE_TASK]: true,
            [TOOL_NAMES.GET_TASK_RESULT]: true,
            [TOOL_NAMES.LIST_TASKS]: true,
            [TOOL_NAMES.CANCEL_TASK]: true,
            [TOOL_NAMES.SKILL]: true,
            [TOOL_NAMES.RUN_COMMAND]: true,
        }));
    });

    it("falls back to Commander for a host-defined agent when host routing is explicitly false", async () => {
        const hostAgent = "subagent_explicit_off";
        await AgentRegistry.getInstance().loadHostAgents({
            app: { agents: async () => ({ data: [{ id: hostAgent, system: "HOST SYSTEM" }] }) },
        });

        const routed = await buildRoutedAgentPrompt(hostAgent, "Stay on Commander", false);

        expect(routed.wireAgent).toBe(AGENT_NAMES.COMMANDER);
        expect(routed.text).not.toContain("HOST SYSTEM");
    });

    it("keeps host agents listed while host routing is off", async () => {
        const hostAgent = "subagent_listed_only";
        await AgentRegistry.getInstance().loadHostAgents({
            app: { agents: async () => ({ data: [{ id: hostAgent, system: "HOST SYSTEM" }] }) },
        });

        // Listing is not gated: delegation must still be able to see the host's
        // agents, it just does not route to them.
        expect(AgentRegistry.getInstance().listAgents()).toContain(hostAgent);
        expect(AgentRegistry.getInstance().isHostAgent(hostAgent)).toBe(true);

        const routed = await buildRoutedAgentPrompt(hostAgent, "Do not route to me");

        expect(routed.wireAgent).toBe(AGENT_NAMES.COMMANDER);
    });

    it("does not ask the host for its agents when host routing is off", async () => {
        // The off path must not pay the round trip: an unknown name is already
        // settled as Commander without re-listing.
        const agents = vi.fn().mockResolvedValue({ data: [{ id: "subagent_never_listed", system: "HOST SYSTEM" }] });
        await AgentRegistry.getInstance().loadHostAgents({ app: { agents } });
        agents.mockClear();

        const routed = await buildRoutedAgentPrompt("subagent_never_listed", "No round trip");

        expect(routed.wireAgent).toBe(AGENT_NAMES.COMMANDER);
        expect(agents).not.toHaveBeenCalled();
    });

    it("keeps built-in routes unchanged once host agents are loaded", async () => {
        await AgentRegistry.getInstance().loadHostAgents({
            app: { agents: async () => ({ data: [{ id: "Worker", system: "HOST WORKER SYSTEM" }] }) },
        });

        const routed = await buildRoutedAgentPrompt(AGENT_NAMES.WORKER, "Implement the assigned file");

        expect(routed.wireAgent).toBe(AGENT_NAMES.WORKER);
        expect(routed.text).toBe("Implement the assigned file");
    });

    it("routes custom agents through Commander while preserving the custom role prompt", async () => {
        const customAgent = "CustomPromptRoutingAgent";
        AgentRegistry.getInstance().registerAgent(customAgent, {
            id: customAgent,
            description: "Custom routing specialist",
            systemPrompt: "CUSTOM ROUTING SYSTEM",
            canWrite: true,
            canBash: false,
        });

        const routed = await buildRoutedAgentPrompt(customAgent, "Continue route audit");

        expect(routed.wireAgent).toBe(AGENT_NAMES.COMMANDER);
        expect(routed.text).toContain("### AGENT ROLE: CustomPromptRoutingAgent");
        expect(routed.text).toContain("Custom routing specialist");
        expect(routed.text).toContain("CUSTOM ROUTING SYSTEM");
        expect(routed.text).toContain("Continue route audit");
        expect(routed.tools).toEqual(expect.objectContaining({
            [TOOL_NAMES.DELEGATE_TASK]: true,
            [TOOL_NAMES.GET_TASK_RESULT]: true,
            [TOOL_NAMES.LIST_TASKS]: true,
            [TOOL_NAMES.CANCEL_TASK]: true,
            [TOOL_NAMES.SKILL]: true,
            [TOOL_NAMES.RUN_COMMAND]: true,
        }));
    });

    it("re-lists the host's agents when the first list predates the host's config merge", async () => {
        // The host merges the user's `agent:` config after plugin setup, so the
        // list taken at setup is missing agents that exist by delegation time.
        const hostAgent = "subagent_late_merge";
        let listed = [{ id: "build", system: "HOST BUILD SYSTEM" }];
        const client = {
            app: {
                agents: async () => ({ data: listed.map(agent => ({ ...agent })) }),
            },
        };
        await AgentRegistry.getInstance().loadHostAgents(client);

        listed = [...listed, { id: hostAgent, description: "Late host agent", system: "HOST SYSTEM" }];

        const routed = await buildRoutedAgentPrompt(hostAgent, "Run the late agent", true);

        expect(routed.wireAgent).toBe(hostAgent);
        expect(routed.text).toBe("Run the late agent");
        expect(routed.text).not.toContain("### AGENT ROLE:");
        expect(routed.tools).not.toHaveProperty(TOOL_NAMES.DELEGATE_TASK);
    });

    it("keeps the custom-role fallback intact when host routing is on", async () => {
        const customAgent = "CustomRoleWithHostRoutingOn";
        AgentRegistry.getInstance().registerAgent(customAgent, {
            id: customAgent,
            description: "Custom routing specialist",
            systemPrompt: "CUSTOM ROUTING SYSTEM",
            canWrite: true,
            canBash: false,
        });

        const routed = await buildRoutedAgentPrompt(customAgent, "Continue route audit", true);

        expect(routed.wireAgent).toBe(AGENT_NAMES.COMMANDER);
        expect(routed.text).toContain("### AGENT ROLE: CustomRoleWithHostRoutingOn");
        expect(routed.text).toContain("CUSTOM ROUTING SYSTEM");
        expect(routed.tools).toHaveProperty(TOOL_NAMES.DELEGATE_TASK, true);
    });

    it("keeps built-in routes unchanged when host routing is on", async () => {
        await AgentRegistry.getInstance().loadHostAgents({
            app: { agents: async () => ({ data: [{ id: "Worker", system: "HOST WORKER SYSTEM" }] }) },
        });

        const routed = await buildRoutedAgentPrompt(AGENT_NAMES.WORKER, "Implement the assigned file", true);

        expect(routed.wireAgent).toBe(AGENT_NAMES.WORKER);
        expect(routed.text).toBe("Implement the assigned file");
    });

    it("prepends relevant memory context before a compact built-in task prompt", async () => {
        MemoryManager.getInstance().add(
            MemoryLevel.PROJECT,
            "Implement route audit with prompt routing evidence",
            1,
        );

        const routed = await buildRoutedAgentPrompt(
            AGENT_NAMES.REVIEWER,
            "Check prompt routing evidence",
        );

        expect(routed.text).toContain("### PROJECT MEMORY");
        expect(routed.text.indexOf("### PROJECT MEMORY"))
            .toBeLessThan(routed.text.indexOf("Check prompt routing evidence"));
        expect(routed.text).not.toContain("### AGENT ROLE:");
    });
});
