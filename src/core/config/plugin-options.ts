import type { PluginOptions } from "@opencode-ai/plugin";
import type { ConcurrencyConfig } from "../agents/concurrency.js";
import { extractConcurrencyConfig } from "../agents/concurrency-config.js";
import {
    type MissionRuntimeOptions,
} from "../loop/mission-runtime-options.js";
import { parseAgentTemperatures, parseContextMaxTokens, parseHostAgentRouting, parseMessageVisibility, parseMissionLoopOptions } from "./options-schema.js";
import { isRecord } from "../../shared/core/guards.js";
import type { MessageVisibility } from "../session/injection.js";

type MissionLoopPluginOptions = MissionRuntimeOptions;

interface OrchestratorPluginOptions {
    concurrency: ConcurrencyConfig;
    missionLoop: MissionLoopPluginOptions;
    /** Explicit context window override; undefined resolves from model metadata. */
    contextMaxTokens?: number;
    agentTemperatures: Record<string, number>;
    messageVisibility: MessageVisibility;
    /** Opt-in: delegate a host agent name to that agent instead of Commander. */
    hostAgentRouting: boolean;
}

export function parseOrchestratorPluginOptions(options?: PluginOptions): OrchestratorPluginOptions {
    const source = isRecord(options) ? options : {};
    return {
        concurrency: extractConcurrencyConfig(source),
        missionLoop: readMissionLoopOptions(source.missionLoop),
        contextMaxTokens: parseContextMaxTokens(source.contextMaxTokens),
        agentTemperatures: parseAgentTemperatures(source.agentTemperatures),
        messageVisibility: parseMessageVisibility(source),
        hostAgentRouting: parseHostAgentRouting(source.hostAgentRouting),
    };
}

function readMissionLoopOptions(value: unknown): MissionLoopPluginOptions {
    // Schema-driven, tolerant parse (invalid/missing fields -> defaults).
    return parseMissionLoopOptions(value);
}

