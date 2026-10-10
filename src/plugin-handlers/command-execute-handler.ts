import type { Hooks } from "@opencode-ai/plugin";
import { MissionControlHook } from "../hooks/features/mission-loop.js";
import { COMMANDS } from "../tools/slashCommand.js";
import { COMMAND_NAMES } from "../shared/index.js";
import type { MessageVisibility } from "../core/session/injection.js";
import type { ToolExecuteHandlerContext } from "./context.js";

type CommandExecuteBeforeHook = NonNullable<Hooks["command.execute.before"]>;

// Native commands arrive after template expansion, so chat.message cannot see /task.
export function createCommandExecuteBeforeHandler(
    ctx: ToolExecuteHandlerContext,
    messageVisibility: MessageVisibility,
): CommandExecuteBeforeHook {
    const missionCommand = new MissionControlHook();
    return async (input, output) => {
        if (!Object.hasOwn(COMMANDS, input.command)) return;
        const command = COMMANDS[input.command];
        if (!command) return;
        const expected = command.template.replace(/\$ARGUMENTS/g, input.arguments);
        const part = output.parts.find(part => part.type === "text" && part.text === expected);
        // A user-owned command with the same name must retain its own behavior.
        if (!part || part.type !== "text") return;

        if (input.command === COMMAND_NAMES.STOP || input.command === COMMAND_NAMES.CANCEL) {
            await missionCommand.execute({ ...ctx, sessionID: input.sessionID }, `/${input.command}`);
        } else if (input.command === COMMAND_NAMES.TASK) {
            await missionCommand.execute({ ...ctx, sessionID: input.sessionID }, `/task ${input.arguments}`);
        }
        // Hiding is opt-in: by default the expanded command stays an ordinary
        // user message, so clients that drop synthetic content (and the TUI,
        // which hides synthetic parts) still show what was asked for.
        if (messageVisibility === "synthetic") part.synthetic = true;
    };
}
