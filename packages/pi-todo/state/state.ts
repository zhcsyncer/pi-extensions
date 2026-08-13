import type { Task } from "../tool/types.js";

/**
 * Canonical V2 live state for the todo tool. Replay always normalizes legacy
 * snapshots into this shape before lifecycle handlers publish it to the store.
 */
export interface TaskState {
	tasks: Task[];
	nextId: number;
	generation: number;
	revision: number;
}

export const EMPTY_STATE: TaskState = {
	tasks: [],
	nextId: 1,
	generation: 1,
	revision: 0,
};

export function createEmptyTaskState(): TaskState {
	return { ...EMPTY_STATE, tasks: [] };
}

/** User reset: clear live tasks without ever reusing an id. */
export function resetTaskState(state: TaskState): TaskState {
	return {
		tasks: [],
		nextId: state.nextId,
		generation: state.generation + 1,
		revision: state.revision + 1,
	};
}
