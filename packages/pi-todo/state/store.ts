import type { Task } from "../tool/types.js";
import { createEmptyTaskState, resetTaskState, type TaskState } from "./state.js";

/**
 * Session-local state boundary used by the tool, command, overlay, and replay
 * handlers that belong to one extension runtime.
 */
export interface TodoStore {
	getTodos(): readonly Task[];
	getNextId(): number;
	getState(): TaskState;
	replaceState(next: TaskState): void;
	commitState(next: TaskState): void;
	reset(): void;
}

function freshState(): TaskState {
	return createEmptyTaskState();
}

/**
 * Create an isolated store for one extension runtime. Keeping the cell inside
 * this factory prevents two AgentSession instances in the same Node.js process
 * from overwriting each other's Todo state through the module cache.
 */
export function createTodoStore(): TodoStore {
	let state = freshState();

	return {
		getTodos: () => state.tasks,
		getNextId: () => state.nextId,
		getState: () => state,
		replaceState: (next) => {
			state = next;
		},
		commitState: (next) => {
			state = next;
		},
		reset: () => {
			state = resetTaskState(state);
		},
	};
}
