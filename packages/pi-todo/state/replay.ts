import type {
	MutationDetailsV2,
	QueryDetailsV2,
	ResetDetailsV2,
	Task,
	TaskDetails,
	TaskDetailsV1,
	TaskStatus,
} from "../tool/types.js";
import { createEmptyTaskState, type TaskState } from "./state.js";

export const TODO_STATE_CUSTOM_TYPE = "pi-todo-state";

const TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(["pending", "in_progress", "completed", "deleted"]);
const MUTATION_ACTIONS = new Set(["create", "update", "delete", "batch"]);
const QUERY_ACTIONS = new Set(["list", "get"]);

type LegacyTask = Task & { activeForm?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTask(value: unknown): value is LegacyTask {
	if (!isRecord(value)) return false;
	if (!Number.isInteger(value.id) || (value.id as number) < 1) return false;
	if (typeof value.subject !== "string" || !TASK_STATUSES.has(value.status as TaskStatus)) return false;
	if (value.description !== undefined && typeof value.description !== "string") return false;
	if (value.activeForm !== undefined && typeof value.activeForm !== "string") return false;
	if (value.owner !== undefined && typeof value.owner !== "string") return false;
	return value.metadata === undefined || isRecord(value.metadata);
}

function isTaskArray(value: unknown): value is LegacyTask[] {
	return Array.isArray(value) && value.every(isTask);
}

function isTaskDetailsV1(value: unknown): value is TaskDetailsV1 {
	if (!isRecord(value)) return false;
	if (value.schemaVersion !== undefined && value.schemaVersion !== 1) return false;
	if (!isTaskArray(value.tasks)) return false;
	if (!Number.isInteger(value.nextId) || (value.nextId as number) < 1) return false;
	return value.params === undefined || isRecord(value.params);
}

export function isTaskStateV2(value: unknown): value is TaskState {
	if (!isRecord(value) || !isTaskArray(value.tasks)) return false;
	if (!Number.isInteger(value.nextId) || (value.nextId as number) < 1) return false;
	if (!Number.isInteger(value.generation) || (value.generation as number) < 1) return false;
	return Number.isInteger(value.revision) && (value.revision as number) >= 0;
}

function isMutationDetailsV2(value: unknown): value is MutationDetailsV2 {
	return (
		isRecord(value) &&
		value.schemaVersion === 2 &&
		value.kind === "checkpoint" &&
		typeof value.action === "string" &&
		MUTATION_ACTIONS.has(value.action) &&
		isRecord(value.params) &&
		isTaskStateV2(value.state)
	);
}

function isQueryDetailsV2(value: unknown): value is QueryDetailsV2 {
	return (
		isRecord(value) &&
		value.schemaVersion === 2 &&
		value.kind === "query" &&
		typeof value.action === "string" &&
		QUERY_ACTIONS.has(value.action)
	);
}

export function isResetDetailsV2(value: unknown): value is ResetDetailsV2 {
	return (
		isRecord(value) &&
		value.schemaVersion === 2 &&
		value.kind === "checkpoint" &&
		value.action === "reset" &&
		isTaskStateV2(value.state)
	);
}

export function isTaskDetails(value: unknown): value is TaskDetails {
	return isTaskDetailsV1(value) || isMutationDetailsV2(value) || isQueryDetailsV2(value);
}

function cloneMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
	return structuredClone(metadata);
}

function cloneTask(task: LegacyTask): Task {
	const current: Task = {
		id: task.id,
		subject: task.subject,
		status: task.status,
	};
	if (task.description !== undefined) current.description = task.description;
	if (task.owner !== undefined) current.owner = task.owner;
	if (task.metadata !== undefined) current.metadata = cloneMetadata(task.metadata);
	return current;
}

function cloneState(state: TaskState): TaskState {
	return {
		tasks: state.tasks.map((task) => cloneTask(task)),
		nextId: state.nextId,
		generation: state.generation,
		revision: state.revision,
	};
}

function stateFromV1(details: TaskDetailsV1): TaskState {
	return {
		tasks: details.tasks.map((task) => cloneTask(task as LegacyTask)),
		nextId: details.nextId,
		generation: 1,
		revision: 0,
	};
}

interface ReplayEntry {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string; toolName?: string; details?: unknown };
}

function checkpointState(entry: unknown): TaskState | undefined {
	const candidate = entry as ReplayEntry;
	if (candidate.type === "custom" && candidate.customType === TODO_STATE_CUSTOM_TYPE) {
		return isResetDetailsV2(candidate.data) ? cloneState(candidate.data.state) : undefined;
	}
	if (candidate.type !== "message") return undefined;
	const message = candidate.message;
	if (message?.role !== "toolResult" || message.toolName !== "todo") return undefined;
	if (isTaskDetailsV1(message.details)) return stateFromV1(message.details);
	if (isMutationDetailsV2(message.details)) return cloneState(message.details.state);
	return undefined;
}

function nextIdFloor(entry: unknown): number | undefined {
	const candidate = entry as ReplayEntry;
	let state: Pick<TaskState, "tasks" | "nextId"> | undefined;
	if (candidate.type === "custom" && candidate.customType === TODO_STATE_CUSTOM_TYPE) {
		if (isResetDetailsV2(candidate.data)) state = candidate.data.state;
	} else if (candidate.type === "message") {
		const message = candidate.message;
		if (message?.role !== "toolResult" || message.toolName !== "todo") return undefined;
		if (isTaskDetailsV1(message.details)) state = message.details;
		else if (isMutationDetailsV2(message.details)) state = message.details.state;
	}
	if (!state) return undefined;
	const highestTaskId = state.tasks.reduce((highest, task) => Math.max(highest, task.id), 0);
	return Math.max(state.nextId, highestTaskId + 1);
}

/**
 * Restore live tasks from the active branch while deriving `nextId` from every
 * checkpoint in the session tree. This keeps branch state local but prevents a
 * later `/tree` navigation (or a legacy V1 clear) from reusing an ID that was
 * already issued on another path. V2 query envelopes never alter either value.
 */
export function replayFromBranch(ctx: {
	sessionManager: {
		getBranch(): Iterable<unknown>;
		getEntries?(): Iterable<unknown>;
	};
}): TaskState {
	let result = createEmptyTaskState();
	for (const entry of ctx.sessionManager.getBranch()) {
		const checkpoint = checkpointState(entry);
		if (checkpoint) result = checkpoint;
	}

	let sessionNextId = result.nextId;
	const entries = ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch();
	for (const entry of entries) {
		const floor = nextIdFloor(entry);
		if (floor !== undefined) sessionNextId = Math.max(sessionNextId, floor);
	}
	return sessionNextId === result.nextId ? result : { ...result, nextId: sessionNextId };
}
