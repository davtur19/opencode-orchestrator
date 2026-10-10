/**
 * Task Resumer - Handles resuming existing parallel task sessions
 */

import type { PluginInput } from "@opencode-ai/plugin";
import {
    TASK_STATUS,
    type ParallelTask,
    type ResumeInput,
} from "../../../shared/index.js";
import { TaskStore } from "../task-store.js";
import { log } from "../logger.js";
import { buildRoutedAgentPrompt, type RoutedAgentPrompt } from "./prompt-routing.js";
import { isSessionBusy } from "../../session/activity.js";

type OpencodeClient = PluginInput["client"];

export interface TaskResumerOptions {
    client: OpencodeClient;
    store: TaskStore;
    findBySession: (sessionID: string) => ParallelTask | undefined;
    startTask: (task: ParallelTask, prompt: RoutedAgentPrompt) => void;
    /** Opt-in: send a host agent name to that agent instead of Commander. */
    hostAgentRouting: boolean;
}

export class TaskResumer {
    private readonly client: OpencodeClient;
    private readonly store: TaskStore;
    private readonly findBySession: (sessionID: string) => ParallelTask | undefined;
    private readonly startTask: (task: ParallelTask, prompt: RoutedAgentPrompt) => void;
    private readonly hostAgentRouting: boolean;

    constructor(options: TaskResumerOptions) {
        this.client = options.client;
        this.store = options.store;
        this.findBySession = options.findBySession;
        this.startTask = options.startTask;
        this.hostAgentRouting = options.hostAgentRouting;
    }

    async resume(input: ResumeInput): Promise<ParallelTask> {
        const existingTask = this.findBySession(input.sessionId);
        if (!existingTask) {
            throw new Error(`Task not found for session: ${input.sessionId}`);
        }

        const startedAt = existingTask.startedAt;
        const routedPrompt = await buildRoutedAgentPrompt(existingTask.agent, input.prompt, this.hostAgentRouting);
        if (await isSessionBusy(this.client, existingTask.sessionID) || existingTask.status === TASK_STATUS.RUNNING || existingTask.status === TASK_STATUS.PENDING) {
            throw new Error(`Cannot resume session ${existingTask.sessionID}: session is still running`);
        }
        if (this.findBySession(input.sessionId) !== existingTask || existingTask.startedAt !== startedAt) {
            throw new Error(`Cannot resume session ${input.sessionId}: task changed while checking activity`);
        }

        existingTask.status = TASK_STATUS.PENDING;
        existingTask.completedAt = undefined;
        existingTask.error = undefined;
        existingTask.result = undefined;
        existingTask.prompt = input.prompt;
        existingTask.hasStartedOutputting = undefined;
        existingTask.lastMsgCount = undefined;
        existingTask.pollFailureCount = undefined;
        existingTask.progress = undefined;
        existingTask.parentSessionID = input.parentSessionID;
        existingTask.startedAt = new Date();
        existingTask.stablePolls = 0;

        this.store.trackPending(input.parentSessionID, existingTask.id);
        log(`Resuming task ${existingTask.id} in session ${existingTask.sessionID}`);
        this.startTask(existingTask, routedPrompt);

        return existingTask;
    }

}
