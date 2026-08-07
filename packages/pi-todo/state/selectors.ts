import type { Task, TaskStatus } from "../tool/types.js";
import type { TaskState } from "./state.js";

/** Tasks excluding deleted tombstones — the canonical "what's visible". */
export function selectVisibleTasks(state: TaskState): readonly Task[] {
	return state.tasks.filter((t) => t.status !== "deleted");
}

/** Total counts for the overlay heading (`Todos (n/m)`). */
export interface TodoCounts {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
}
export function selectTodoCounts(state: TaskState): TodoCounts {
	const visible = selectVisibleTasks(state);
	return {
		total: visible.length,
		pending: visible.filter((task) => task.status === "pending").length,
		inProgress: visible.filter((task) => task.status === "in_progress").length,
		completed: visible.filter((task) => task.status === "completed").length,
	};
}

/**
 * Whether any visible task carries a `blockedBy` reference. The overlay uses
 * this to gate the `#id` prefix on per-task rows — without at least one
 * `⛓ #N` suffix, the per-row id has no anchor.
 */
export function selectShowTaskIds(state: TaskState): boolean {
	return selectVisibleTasks(state).some((t) => t.blockedBy && t.blockedBy.length > 0);
}

/**
 * Resolve a task's subject by id from the live state for renderCall's
 * accent label. `undefined` when the id is unknown — caller falls back to
 * `#id` plain rendering.
 */
export function selectTaskSubjectById(state: TaskState, id: number): string | undefined {
	return state.tasks.find((t) => t.id === id)?.subject;
}

/**
 * Select task rows for the widget body. `budget` covers task rows plus an
 * overflow summary when needed; the caller separately reserves the heading
 * and trailing spacer. Overflow admission is status-prioritized
 * (`in_progress`, `pending`, `completed`), while the returned rows retain the
 * store's natural order so status transitions do not reorder the whole list.
 */
export interface OverlayLayout {
	visible: readonly Task[];
	hiddenPending: number;
	hiddenCompleted: number;
}
export function selectOverlayLayout(state: TaskState, budget: number): OverlayLayout {
	const all = selectVisibleTasks(state);
	if (all.length <= budget) {
		return { visible: all, hiddenPending: 0, hiddenCompleted: 0 };
	}

	const taskBudget = Math.max(0, budget - 1);
	const prioritized = [
		...all.filter((task) => task.status === "in_progress"),
		...all.filter((task) => task.status === "pending"),
		...all.filter((task) => task.status === "completed"),
	];
	const selected = new Set(prioritized.slice(0, taskBudget));
	const visible = all.filter((task) => selected.has(task));

	return {
		visible,
		hiddenPending:
			all.filter((task) => task.status === "pending").length -
			visible.filter((task) => task.status === "pending").length,
		hiddenCompleted:
			all.filter((task) => task.status === "completed").length -
			visible.filter((task) => task.status === "completed").length,
	};
}

/**
 * Helper: whether any visible task is `pending` or `in_progress`. The overlay
 * uses this to pick the heading emphasis from the active icon preset.
 */
export function selectHasActive(state: TaskState): boolean {
	return selectVisibleTasks(state).some((t) => t.status === "in_progress" || t.status === "pending");
}

export const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set(["pending", "in_progress"]);
