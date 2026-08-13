import type {
	Task,
	TaskAction,
	TaskBatchOperation,
	TaskMutationParams,
	TaskStatus,
} from "../tool/types.js";
import { isTransitionValid } from "./invariants.js";
import type { TaskState } from "./state.js";

export type BatchItemOp =
	| { kind: "create"; taskId: number; status: TaskStatus }
	| { kind: "update"; id: number; fromStatus: TaskStatus; toStatus: TaskStatus }
	| { kind: "delete"; id: number; subject: string };

export type Op =
	| BatchItemOp
	| { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
	| { kind: "get"; task: Task }
	| { kind: "batch"; operations: BatchItemOp[] }
	| { kind: "error"; message: string };

export interface ApplyResult {
	state: TaskState;
	op: Op;
}

function errorResult(state: TaskState, message: string): ApplyResult {
	return { state, op: { kind: "error", message } };
}

function otherInProgressTask(tasks: readonly Task[], currentId?: number): Task | undefined {
	return tasks.find((task) => task.id !== currentId && task.status === "in_progress");
}

function formatBatchOperation(operation: TaskBatchOperation): string {
	switch (operation.action) {
		case "create":
			return `create${operation.subject ? ` “${operation.subject}”` : ""}${operation.status ? ` → ${operation.status}` : ""}`;
		case "update":
			return `update${operation.id !== undefined ? ` #${operation.id}` : ""}${operation.status ? ` → ${operation.status}` : ""}`;
		case "delete":
			return `delete${operation.id !== undefined ? ` #${operation.id}` : ""}`;
	}
}

function hasActiveTasks(tasks: readonly Task[]): boolean {
	return tasks.some((task) => task.status === "pending" || task.status === "in_progress");
}

function isAllTerminal(state: TaskState): boolean {
	return state.tasks.length > 0 && !hasActiveTasks(state.tasks);
}

function rollover(state: TaskState): TaskState {
	return {
		tasks: [],
		nextId: state.nextId,
		generation: state.generation + 1,
		revision: state.revision,
	};
}

function finalizeMutation(original: TaskState, result: ApplyResult): ApplyResult {
	if (result.op.kind === "error") return { state: original, op: result.op };
	return {
		state: { ...result.state, revision: original.revision + 1 },
		op: result.op,
	};
}

function applyCreate(state: TaskState, params: TaskMutationParams): ApplyResult {
	if (!params.subject?.trim()) {
		return errorResult(state, "subject required for create");
	}

	const initialStatus = params.status ?? "pending";
	if (initialStatus !== "pending" && initialStatus !== "in_progress") {
		return errorResult(state, `cannot create #${state.nextId} with status ${initialStatus}; use pending or in_progress`);
	}

	if (initialStatus === "in_progress") {
		const active = otherInProgressTask(state.tasks);
		if (active) {
			return errorResult(
				state,
				`cannot create #${state.nextId} in_progress: #${active.id} is already in_progress; complete or re-queue #${active.id} first`,
			);
		}
	}

	const newTask: Task = {
		id: state.nextId,
		subject: params.subject,
		status: initialStatus,
	};
	if (params.description) newTask.description = params.description;
	if (params.owner) newTask.owner = params.owner;
	if (params.metadata) newTask.metadata = { ...params.metadata };

	return {
		state: {
			...state,
			tasks: [...state.tasks, newTask],
			nextId: state.nextId + 1,
		},
		op: { kind: "create", taskId: newTask.id, status: newTask.status },
	};
}

function applyUpdate(state: TaskState, params: TaskMutationParams): ApplyResult {
	if (params.id === undefined) return errorResult(state, "id required for update");
	const idx = state.tasks.findIndex((task) => task.id === params.id);
	if (idx === -1) return errorResult(state, `#${params.id} not found`);
	const current = state.tasks[idx]!;

	const hasMutation =
		params.subject !== undefined ||
		params.description !== undefined ||
		params.status !== undefined ||
		params.owner !== undefined ||
		params.metadata !== undefined;
	if (!hasMutation) return errorResult(state, "update requires at least one mutable field");
	if (params.subject !== undefined && !params.subject.trim()) {
		return errorResult(state, "subject must not be empty");
	}

	let newStatus = current.status;
	if (params.status !== undefined) {
		if (!isTransitionValid(current.status, params.status)) {
			return errorResult(state, `cannot update #${current.id}: illegal transition ${current.status} → ${params.status}`);
		}
		newStatus = params.status;
	}

	if (newStatus === "in_progress") {
		const active = otherInProgressTask(state.tasks, current.id);
		if (active) {
			return errorResult(
				state,
				`cannot start #${current.id}: #${active.id} is already in_progress; complete or re-queue #${active.id} before starting #${current.id}`,
			);
		}
	}

	let newMetadata = current.metadata;
	if (params.metadata !== undefined) {
		const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
		for (const [key, value] of Object.entries(params.metadata)) {
			if (value === null) delete merged[key];
			else merged[key] = value;
		}
		newMetadata = Object.keys(merged).length ? merged : undefined;
	}

	const updated: Task = { ...current, status: newStatus };
	if (params.subject !== undefined) updated.subject = params.subject;
	if (params.description !== undefined) updated.description = params.description;
	if (params.owner !== undefined) updated.owner = params.owner;
	if (newMetadata === undefined) delete updated.metadata;
	else updated.metadata = newMetadata;

	const newTasks = [...state.tasks];
	newTasks[idx] = updated;
	return {
		state: { ...state, tasks: newTasks },
		op: { kind: "update", id: updated.id, fromStatus: current.status, toStatus: newStatus },
	};
}

function applyDelete(state: TaskState, params: TaskMutationParams): ApplyResult {
	if (params.id === undefined) return errorResult(state, "id required for delete");
	const idx = state.tasks.findIndex((task) => task.id === params.id);
	if (idx === -1) return errorResult(state, `#${params.id} not found`);
	const current = state.tasks[idx]!;
	if (current.status === "deleted") return errorResult(state, `#${current.id} is already deleted`);

	const updated: Task = { ...current, status: "deleted" };
	const newTasks = [...state.tasks];
	newTasks[idx] = updated;
	return {
		state: { ...state, tasks: newTasks },
		op: { kind: "delete", id: updated.id, subject: updated.subject },
	};
}

function applyBatchOperation(state: TaskState, operation: TaskBatchOperation): ApplyResult {
	switch (operation.action) {
		case "create":
			return applyCreate(state, operation);
		case "update":
			return applyUpdate(state, operation);
		case "delete":
			return applyDelete(state, operation);
	}
}

/** Pure top-level reducer. Rollover and revision changes are committed atomically. */
export function applyTaskMutation(state: TaskState, action: TaskAction, params: TaskMutationParams): ApplyResult {
	switch (action) {
		case "create": {
			const base = isAllTerminal(state) ? rollover(state) : state;
			return finalizeMutation(state, applyCreate(base, params));
		}

		case "update":
			return finalizeMutation(state, applyUpdate(state, params));

		case "delete":
			return finalizeMutation(state, applyDelete(state, params));

		case "batch": {
			if (!params.operations?.length) return errorResult(state, "operations required for batch");
			if (params.operations.length > 50) return errorResult(state, "batch supports at most 50 operations");

			const shouldRollover = isAllTerminal(state) && params.operations.some((operation) => operation.action === "create");
			let nextState = shouldRollover ? rollover(state) : state;
			const operations: BatchItemOp[] = [];
			for (const [index, operation] of params.operations.entries()) {
				const result = applyBatchOperation(nextState, operation);
				if (result.op.kind === "error") {
					return errorResult(
						state,
						`batch operation ${index + 1} (${formatBatchOperation(operation)}): ${result.op.message}`,
					);
				}
				if (result.op.kind !== "create" && result.op.kind !== "update" && result.op.kind !== "delete") {
					return errorResult(state, `batch operation ${index + 1}: unsupported action ${operation.action}`);
				}
				operations.push(result.op);
				nextState = result.state;
			}
			return {
				state: { ...nextState, revision: state.revision + 1 },
				op: { kind: "batch", operations },
			};
		}

		case "list":
			return {
				state,
				op: {
					kind: "list",
					includeDeleted: params.includeDeleted === true,
					...(params.status !== undefined ? { statusFilter: params.status } : {}),
				},
			};

		case "get": {
			if (params.id === undefined) return errorResult(state, "id required for get");
			const task = state.tasks.find((candidate) => candidate.id === params.id);
			if (!task) return errorResult(state, `#${params.id} not found`);
			return { state, op: { kind: "get", task } };
		}
	}
}
