import type { Task, TaskDetails, TaskStatus } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";

/**
 * Discriminator for `details` envelopes that match the persisted `TaskDetails`
 * shape. Defensive — branch entries from older or corrupt sessions are
 * skipped silently.
 */
const TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(["pending", "in_progress", "completed", "deleted"]);

type LegacyTask = Task & { activeForm?: string };

function isTask(value: unknown): value is LegacyTask {
	if (!value || typeof value !== "object") return false;
	const task = value as Record<string, unknown>;
	if (!Number.isInteger(task.id) || (task.id as number) < 1) return false;
	if (typeof task.subject !== "string" || !TASK_STATUSES.has(task.status as TaskStatus)) return false;
	if (task.description !== undefined && typeof task.description !== "string") return false;
	if (task.activeForm !== undefined && typeof task.activeForm !== "string") return false;
	if (task.owner !== undefined && typeof task.owner !== "string") return false;
	if (
		task.blockedBy !== undefined &&
		(!Array.isArray(task.blockedBy) || !task.blockedBy.every((id) => Number.isInteger(id) && id > 0))
	) {
		return false;
	}
	return task.metadata === undefined || (!!task.metadata && typeof task.metadata === "object" && !Array.isArray(task.metadata));
}

export function isTaskDetails(value: unknown): value is TaskDetails {
	if (!value || typeof value !== "object") return false;
	const snapshot = value as Record<string, unknown>;
	if (snapshot.schemaVersion !== undefined && snapshot.schemaVersion !== 1) return false;
	if (!Array.isArray(snapshot.tasks) || !snapshot.tasks.every(isTask)) return false;
	if (!Number.isInteger(snapshot.nextId) || (snapshot.nextId as number) < 1) return false;
	return (
		snapshot.params === undefined ||
		(!!snapshot.params && typeof snapshot.params === "object" && !Array.isArray(snapshot.params))
	);
}

/**
 * Walk the current branch in chronological order; the LAST `toolResult` whose
 * `toolName === "todo"` and whose `details` shape matches `TaskDetails` wins
 * (last-write-wins). When no matching entry exists, returns `EMPTY_STATE`.
 *
 * Pure of runtime state — `index.ts` writes the returned snapshot into its
 * injected store after this returns. The function does not touch the store cell.
 */
function stripLegacyFields(task: LegacyTask): Task {
	const { activeForm: _legacyActiveForm, ...current } = task;
	return current;
}

export function replayFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TaskState {
	let result: TaskState = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as { type?: string; message?: { role?: string; toolName?: string; details?: unknown } };
		if (e.type !== "message") continue;
		const msg = e.message;
		if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
		if (!isTaskDetails(msg.details)) continue;
		result = {
			tasks: msg.details.tasks.map((task) => stripLegacyFields(task as LegacyTask)),
			nextId: msg.details.nextId,
		};
	}
	return result;
}
