import type { TaskStatus } from "../tool/types.js";

/**
 * Normal lifecycle: pending → in_progress → completed. Pending may also move
 * directly to completed when reconciling work finished before status tracking.
 * An in-progress task may return to pending when separate interrupting work
 * takes focus. Any live task may be tombstoned; completed and deleted tasks
 * cannot reopen.
 *
 * Idempotent same→same is checked separately in `isTransitionValid` so this
 * table only enumerates actual transitions.
 */
export const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
	pending: new Set(["in_progress", "completed", "deleted"]),
	in_progress: new Set(["pending", "completed", "deleted"]),
	completed: new Set(["deleted"]),
	deleted: new Set(),
};

export function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
	if (from === to) return true;
	return VALID_TRANSITIONS[from].has(to);
}
