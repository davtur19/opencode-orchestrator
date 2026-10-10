import type { Plugin } from "@opencode/plugin";
import { MissionControlHook } from "../hooks/features/mission-loop.js";
import { COMMANDS } from "../tools/slashCommand.js";
import { PROMPTS } from "../shared/index.js";
import type { MessageVisibility } from "../core/session/injection.js";
import type { PluginHandlerContext } from "../plugin-handlers/context.js";

type Context = Plugin.Context;
type Registration = Awaited<ReturnType<Context["command"]["transform"]>>;
type CommandEditor = Parameters<Parameters<Context["command"]["transform"]>[0]>[0];
type CommandDefinition = Parameters<CommandEditor["add"]>[0];
type CommandInvocation = Parameters<CommandDefinition["execute"]>[0];

export async function registerV2Commands(
    context: Context,
    handlerContext: PluginHandlerContext,
    messageVisibility: MessageVisibility,
): Promise<Registration> {
    return context.command.transform(editor => {
        for (const [name, command] of Object.entries(COMMANDS)) {
            editor.add({
                name,
                description: command.description,
                execute: input => executeCommand(context, handlerContext, name, input, messageVisibility),
            });
        }
    });
}

async function executeCommand(
    context: Context,
    handlerContext: PluginHandlerContext,
    name: string,
    input: CommandInvocation,
    messageVisibility: MessageVisibility,
): Promise<void> {
    const argument = input.prompt.text || PROMPTS.CONTINUE_DEFAULT;
    const mission = new MissionControlHook();
    const result = await mission.execute(
        { ...handlerContext, sessionID: input.sessionID },
        `/${name} ${argument}`,
    );
    if (name === "stop" || name === "cancel") return;
    const template = COMMANDS[name]?.template;
    const text = result.modifiedMessage ?? template?.replace(/\$ARGUMENTS/g, argument);
    if (text) await deliverCommandPrompt(context, input.sessionID, text, messageVisibility);
}

/**
 * Send what the command expanded to.
 *
 * The host stores no user message for a slash command, so this is the only
 * record the transcript gets. A `synthetic` delivery is a message of that role,
 * which chat UIs drop (openchamber skips it in `timelineRoles.ts`) — the user
 * would never see what they asked for — so the default is an ordinary prompt.
 */
async function deliverCommandPrompt(
    context: Context,
    sessionID: string,
    text: string,
    messageVisibility: MessageVisibility,
): Promise<void> {
    if (messageVisibility === "synthetic") {
        await context.session.synthetic({ sessionID, text, resume: true });
        return;
    }
    await context.session.prompt({ sessionID, text });
}
