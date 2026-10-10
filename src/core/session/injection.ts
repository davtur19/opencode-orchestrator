/**
 * Session prompt injection helpers.
 *
 * Every prompt this plugin pushes into a session that a human is watching is
 * orchestrator-generated, not something the user typed. OpenCode models exactly
 * that distinction with the `synthetic` flag on a text part
 * (`TextPartInput.synthetic`, see `packages/schema/src/v1/session.ts` upstream):
 *
 * - The TUI hides text parts where `synthetic === true` when it renders the
 *   conversation and when it picks the "last user message" for editing
 *   (`packages/tui/src/routes/session/index.tsx`).
 * - The model still receives them: `MessageV2.toModelMessage` only filters on
 *   `ignored`, never on `synthetic`.
 * - OpenCode itself marks its own injected turns this way (post-compaction
 *   auto-continue, "the following tool was executed by the user").
 *
 * So `synthetic: true` is exactly the right flag for continuation, recovery and
 * anomaly prompts: the LLM keeps reading them, the user stops seeing them
 * masquerading as their own input.
 *
 * That hiding is wrong for the one prompt that replaces something the user
 * typed: a slash command. The host persists no user message for a slash
 * command at all (`SessionCommand.execute` on the OC2 host only runs the
 * command), so a command sent `synthetic` leaves the transcript with no trace
 * of the request, and chat UIs drop `synthetic` messages outright (openchamber
 * skips that role in `timelineRoles.ts`). The `messageVisibility` plugin option
 * therefore decides how a slash command is delivered; `"synthetic"` restores
 * the hiding described above.
 *
 * Delegation prompts sent to a freshly created *subagent* session are
 * deliberately NOT synthetic: they are that session's real opening instruction,
 * and OpenCode derives the session title from the first non-synthetic user
 * message.
 */

import { PART_TYPES } from "../../shared/index.js";

/**
 * How the plugin delivers the prompt a slash command expands to.
 *
 * - `"synthetic"` — the legacy behavior documented above: hidden in the TUI.
 * - `"visible"` — an ordinary prompt, so the user sees what they asked for in
 *   every client. The default, because the command path is the only place the
 *   plugin replaces input the user actually typed.
 */
export type MessageVisibility = "synthetic" | "visible";

export const DEFAULT_MESSAGE_VISIBILITY: MessageVisibility = "visible";

/** A text part accepted by `client.session.prompt`. */
interface SyntheticTextPart {
    type: typeof PART_TYPES.TEXT;
    text: string;
    /** Hides the part in the TUI while keeping it in the model context. */
    synthetic: true;
}

/** Wrap orchestrator-authored text as a single synthetic prompt part. */
export function syntheticTextPart(text: string): SyntheticTextPart {
    return { type: PART_TYPES.TEXT, text, synthetic: true };
}

/** Wrap several orchestrator-authored prompts as synthetic parts. */
export function syntheticTextParts(texts: readonly string[]): SyntheticTextPart[] {
    return texts.map(syntheticTextPart);
}
