/**
 * Agent Registry - Manages built-in and custom agent definitions
 */

import { AGENTS as BUILTIN_AGENTS } from "../../agents/definitions.js";
import type { AgentDefinition } from "../../shared/agent/index.js";
import { log } from "./logger.js";
import * as fs from "fs/promises";
import * as path from "path";
import { PATHS } from "../../shared/index.js";

import { z } from "zod";
import { parse as parseJsonc } from "jsonc-parser";

// Schema for Agent Definition
const AgentDefinitionSchema = z.object({
    id: z.string(), // ID is required inside the definition object
    description: z.string(),
    systemPrompt: z.string(),
    mode: z.enum(["primary", "subagent"]).optional(),
    color: z.string().optional(),
    hidden: z.boolean().optional(),
    canWrite: z.boolean(), // Required per interface
    canBash: z.boolean(), // Required per interface
});

/**
 * Minimal shape of the client endpoint that lists the host's agents. Both hosts
 * expose it: OpenCode 1 natively, OpenCode 2 through the plugin's own client
 * bridge (`client.app.agents()` -> `context.agent.list()`).
 */
type HostAgentClient = {
    app?: { agents?: () => Promise<{ data?: unknown }> };
};

interface HostAgentInfo {
    id?: unknown;
    description?: unknown;
    system?: unknown;
    /** Hosts hide their own system-prompt stages (title, summary, compaction). */
    hidden?: unknown;
}

export class AgentRegistry {
    private static instance: AgentRegistry;
    private agents: Map<string, AgentDefinition> = new Map();
    /** Names the host can run itself; unlike plugin roles these need no Commander fallback. */
    private hostAgents: Set<string> = new Set();
    private directory: string = "";
    private loadPromise: Promise<void> = Promise.resolve();

    private constructor() {
        // Load built-in agents
        for (const [name, def] of Object.entries(BUILTIN_AGENTS)) {
            this.agents.set(name, def);
        }
    }

    public static getInstance(): AgentRegistry {
        if (!AgentRegistry.instance) {
            AgentRegistry.instance = new AgentRegistry();
        }
        return AgentRegistry.instance;
    }

    public static _resetForTesting(): void {
        AgentRegistry.instance = new AgentRegistry();
    }

    public setDirectory(dir: string): void {
        this.directory = dir;
        this.loadPromise = this.loadCustomAgents();
    }

    /**
     * Register the host's own agent definitions so delegation can target them
     * directly. Runs after the directory load, so a name the plugin already
     * knows (a built-in or a `.opencode/agents.json` role) keeps its routing.
     */
    public loadHostAgents(client: HostAgentClient): Promise<void> {
        this.loadPromise = this.loadPromise.then(() => this.registerHostAgents(client));
        return this.loadPromise;
    }

    public async ready(): Promise<void> {
        await this.loadPromise;
    }

    /**
     * True when the name came from the host's agent list rather than from a
     * plugin role. The host applies these agents' own system prompts, so their
     * definitions must never be re-injected into a prompt.
     */
    public isHostAgent(name: string): boolean {
        return this.hostAgents.has(name);
    }

    /**
     * Get agent definition by name
     */
    public getAgent(name: string): AgentDefinition | undefined {
        return this.agents.get(name);
    }

    /**
     * List all available agent names
     */
    public listAgents(): string[] {
        return Array.from(this.agents.keys());
    }

    /**
     * Add or update an agent definition
     */
    public registerAgent(name: string, def: AgentDefinition): void {
        this.agents.set(name, def);
        log(`[AgentRegistry] Registered agent: ${name}`);
    }

    /**
     * Load custom agents from .opencode/agents.json
     */
    private async loadCustomAgents(): Promise<void> {
        if (!this.directory) return;

        const agentsConfigPath = path.join(this.directory, PATHS.AGENTS_CONFIG);
        try {
            const content = await fs.readFile(agentsConfigPath, "utf-8");
            // Tolerate comments and trailing commas in hand-edited agents config.
            const customAgents = parseJsonc(content);

            if (typeof customAgents === "object" && customAgents !== null) {
                this.registerCustomAgents(customAgents);
            }
        } catch (error) {
            // File might not exist, ignore
            const nodeError = error as NodeJS.ErrnoException;
            if (nodeError.code !== "ENOENT") {
                log(`[AgentRegistry] Error loading custom agents: ${error}`);
            }
        }
    }

    private async registerHostAgents(client: HostAgentClient): Promise<void> {
        const listed = await readHostAgents(client);
        const registered: string[] = [];

        for (const info of listed) {
            const name = typeof info.id === "string" ? info.id : "";
            // A name the plugin already defines keeps its own routing: built-ins
            // must never be shadowed, and an agents.json role intentionally rides
            // on Commander with its role prompt.
            if (!name || this.agents.has(name)) continue;
            // The host's hidden agents are its internal system-prompt stages, not
            // roles a child session can be sent to run.
            if (info.hidden === true) continue;

            this.hostAgents.add(name);
            this.agents.set(name, {
                id: name,
                description: typeof info.description === "string" && info.description
                    ? info.description
                    : `Host agent ${name}`,
                systemPrompt: typeof info.system === "string" ? info.system : "",
                canWrite: true,
                canBash: true,
            });
            registered.push(name);
        }

        if (registered.length > 0) {
            log(`[AgentRegistry] Registered host agents: ${registered.join(", ")}`);
        }
    }

    private registerCustomAgents(customAgents: object): void {
        for (const [name, def] of Object.entries(customAgents)) {
            const result = AgentDefinitionSchema.safeParse(def);
            if (result.success) {
                this.registerAgent(name, result.data);
            } else {
                log(`[AgentRegistry] Invalid custom agent definition for: ${name}. Errors: ${result.error.message}`);
            }
        }
    }
}

/** A host that cannot list its agents is not fatal: delegation keeps the built-in routes. */
async function readHostAgents(client: HostAgentClient): Promise<HostAgentInfo[]> {
    try {
        const response = await client.app?.agents?.();
        return Array.isArray(response?.data) ? response.data as HostAgentInfo[] : [];
    } catch (error) {
        log(`[AgentRegistry] Could not list host agents: ${error}`);
        return [];
    }
}
