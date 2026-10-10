/**
 * Schema-driven plugin options (Builder learning, Phase G).
 *
 * Builder derives one JSON Schema from its config types so the TOML, the schema
 * file, and the editor UI never drift (`builder.schema.json` via schemars).
 * Orchestrator models its plugin-tuple options as Zod here, which is both the
 * runtime validator and the source for the exported JSON Schema.
 *
 * Parsing stays tolerant — invalid or missing fields fall back to defaults —
 * to preserve the previous hand-rolled behavior exactly.
 */
import { z } from "zod";
import { DEFAULT_MISSION_RUNTIME_OPTIONS } from "../loop/mission-runtime-options.js";
import { DEFAULT_MESSAGE_VISIBILITY, type MessageVisibility } from "../session/injection.js";
import { isRecord } from "../../shared/core/guards.js";

const D = DEFAULT_MISSION_RUNTIME_OPTIONS;

const MissionLoopOptionsSchema = z
    .object({
        ledger: z.boolean().catch(D.ledger).default(D.ledger),
        markdownMemory: z.boolean().catch(D.markdownMemory).default(D.markdownMemory),
        maxEvidenceEvents: z
            .number()
            .int()
            .positive()
            .catch(D.maxEvidenceEvents)
            .default(D.maxEvidenceEvents),
    })
    .catch({ ...D });

const ConcurrencyMap = z.record(z.string(), z.number().int().nonnegative());
const Temperature = z.number().finite().min(0).max(2);

/** Full plugin-tuple options object — used to generate the public JSON Schema. */
export const OrchestratorOptionsSchema = z
    .object({
        agentConcurrency: ConcurrencyMap.optional(),
        agentTemperatures: z.record(z.string(), Temperature).optional(),
        providerConcurrency: ConcurrencyMap.optional(),
        modelConcurrency: ConcurrencyMap.optional(),
        defaultConcurrency: z.number().int().nonnegative().optional(),
        acquisitionTimeoutMs: z.number().int().positive().optional(),
        circuitFailureThreshold: z.number().int().positive().optional(),
        circuitRecoveryTimeoutMs: z.number().int().positive().optional(),
        halfOpenSuccessThreshold: z.number().int().positive().optional(),
        resourcePressureMaxHeapPercent: z.number().positive().max(100).optional(),
        /**
         * Context window size to assume for every model, in tokens. Unset means
         * "use the limit the host reports for the model in use".
         */
        contextMaxTokens: z.number().int().positive().optional(),
        missionLoop: MissionLoopOptionsSchema.optional(),
        /**
         * How a slash command's expanded prompt reaches the session.
         * `visible` (the default) sends it as an ordinary prompt; `synthetic`
         * hides it. Loop continuation and recovery injections are always
         * synthetic and ignore this option.
         */
        messageVisibility: z.enum(["synthetic", "visible"]).optional(),
        /** Legacy boolean alias for messageVisibility: true -> visible, false -> synthetic. Ignored when messageVisibility is valid. */
        showInjectedMessages: z.boolean().optional(),
    })
    .passthrough();

/** Tolerant parse of the `contextMaxTokens` option: invalid values mean "unset". */
export function parseContextMaxTokens(value: unknown): number | undefined {
    const parsed = z.number().int().positive().safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

/**
 * Tolerant resolution of the `messageVisibility` option: absent or invalid means
 * the default. `showInjectedMessages` is the boolean alias (true -> visible,
 * false -> synthetic); a valid explicit `messageVisibility` wins.
 */
export function parseMessageVisibility(value: unknown): MessageVisibility {
    const source = isRecord(value) ? value : {};
    const explicit = z.enum(["synthetic", "visible"]).safeParse(source.messageVisibility);
    if (explicit.success) return explicit.data;
    if (typeof source.showInjectedMessages === "boolean") {
        return source.showInjectedMessages ? "visible" : "synthetic";
    }
    return DEFAULT_MESSAGE_VISIBILITY;
}

export function parseAgentTemperatures(value: unknown): Record<string, number> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([agent, raw]) => {
        const result = Temperature.safeParse(raw);
        return result.success ? [[agent, result.data]] : [];
    }));
}

/** Tolerant parse of the `missionLoop` option block. */
export function parseMissionLoopOptions(value: unknown) {
    return MissionLoopOptionsSchema.parse(value);
}

/** JSON Schema for editor autocomplete / external validation. */
export function orchestratorOptionsJsonSchema(): unknown {
    return z.toJSONSchema(OrchestratorOptionsSchema);
}
