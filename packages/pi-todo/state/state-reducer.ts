import type { Task, TaskAction, TaskMutationParams, TaskStatus } from "../tool/types.js";
import { isTransitionValid } from "./invariants.js";
import type { TaskState } from "./state.js";
import { detectCycle } from "./task-graph.js";

/**
 * Reducer outcome. Closed tagged union — adding a new action requires extending
 * this union AND the response-envelope's `formatContent` switch (compiler-
 * enforced exhaustive). Mirrors the `Effect` pattern in
 * `packages/rpiv-ask-user-question/state/state-reducer.ts:14-30`.
 *
 * `error` carries the message in-band so callers can pattern-match on
 * `op.kind === "error"` without a side-channel boolean.
 */
export type BatchItemOp =
	| { kind: "create"; taskId: number; status: TaskStatus }
	| { kind: "update"; id: number; fromStatus: TaskStatus; toStatus: TaskStatus }
	| { kind: "delete"; id: number; subject: string };

export type Op =
	| BatchItemOp
	| { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
	| { kind: "get"; task: Task }
	| { kind: "clear"; count: number }
	| { kind: "batch"; operations: BatchItemOp[] }
	| { kind: "error"; message: string };

export interface ApplyResult {
	state: TaskState;
	op: Op;
}

function errorResult(state: TaskState, message: string): ApplyResult {
	return { state, op: { kind: "error", message } };
}

function firstIncompleteDependencyId(tasks: readonly Task[], blockedBy: readonly number[]): number | undefined {
	return blockedBy.find((id) => tasks.find((task) => task.id === id)?.status !== "completed");
}

function otherInProgressTask(tasks: readonly Task[], currentId?: number): Task | undefined {
	return tasks.find((task) => task.id !== currentId && task.status === "in_progress");
}

function formatBatchOperation(operation: NonNullable<TaskMutationParams["operations"]>[number]): string {
	switch (operation.action) {
		case "create":
			return `create${operation.subject ? ` “${operation.subject}”` : ""}${operation.status ? ` → ${operation.status}` : ""}`;
		case "update":
			return `update${operation.id !== undefined ? ` #${operation.id}` : ""}${operation.status ? ` → ${operation.status}` : ""}`;
		case "delete":
			return `delete${operation.id !== undefined ? ` #${operation.id}` : ""}`;
	}
}

/**
 * Pure reducer: (state, action, params) → (state, op). Mirrors the
 * `applyTaskMutation` of pre-refactor `todo.ts` minus content/details
 * formatting; the response envelope (`tool/response-envelope.ts`) owns
 * formatting, the store (`state/store.ts`) owns commit.
 *
 * Validation is in-line: structural guards (`subject required`, `id required`,
 * `at least one mutable field`) plus state-aware checks (transition legality,
 * dangling/deleted blockedBy, self-block, cycles). Decision: validation stays
 * in-reducer — see Plan §Decisions §Decision 2.
 */
export function applyTaskMutation(state: TaskState, action: TaskAction, params: TaskMutationParams): ApplyResult {
	switch (action) {
		case "create": {
			if (!params.subject?.trim()) {
				return errorResult(state, "subject required for create");
			}

			const initialStatus = params.status ?? "pending";
			if (initialStatus !== "pending" && initialStatus !== "in_progress") {
				return errorResult(state, `cannot create #${state.nextId} with status ${initialStatus}; use pending or in_progress`);
			}

			const blockedBy = [...new Set(params.blockedBy ?? [])];
			for (const dep of blockedBy) {
				const depTask = state.tasks.find((t) => t.id === dep);
				if (!depTask) return errorResult(state, `blockedBy: #${dep} not found`);
				if (depTask.status === "deleted") return errorResult(state, `blockedBy: #${dep} is deleted`);
			}

			if (initialStatus === "in_progress") {
				const active = otherInProgressTask(state.tasks);
				if (active) {
					return errorResult(
						state,
						`cannot create #${state.nextId} in_progress: #${active.id} is already in_progress; complete or re-queue #${active.id} first`,
					);
				}
				const blockerId = firstIncompleteDependencyId(state.tasks, blockedBy);
				if (blockerId) return errorResult(state, `#${state.nextId} is blocked by incomplete task #${blockerId}`);
			}

			const newTask: Task = {
				id: state.nextId,
				subject: params.subject,
				status: initialStatus,
			};
			if (params.description) newTask.description = params.description;
			if (blockedBy.length) newTask.blockedBy = blockedBy;
			if (params.owner) newTask.owner = params.owner;
			if (params.metadata) newTask.metadata = { ...params.metadata };

			const newTasks = [...state.tasks, newTask];
			return {
				state: { tasks: newTasks, nextId: state.nextId + 1 },
				op: { kind: "create", taskId: newTask.id, status: newTask.status },
			};
		}

		case "update": {
			if (params.id === undefined) return errorResult(state, "id required for update");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];

			const hasMutation =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.status !== undefined ||
				params.owner !== undefined ||
				params.metadata !== undefined ||
				(params.addBlockedBy && params.addBlockedBy.length > 0) ||
				(params.removeBlockedBy && params.removeBlockedBy.length > 0);
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

			let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
			if (params.removeBlockedBy?.length) {
				const toRemove = new Set(params.removeBlockedBy);
				newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
			}
			if (params.addBlockedBy?.length) {
				for (const dep of params.addBlockedBy) {
					if (dep === current.id) return errorResult(state, `cannot block #${current.id} on itself`);
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `addBlockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `addBlockedBy: #${dep} is deleted`);
					if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
				}
				if (detectCycle(state.tasks, current.id, newBlockedBy)) {
					return errorResult(state, "addBlockedBy would create a cycle in the blockedBy graph");
				}
			}

			if (newStatus === "in_progress") {
				const active = otherInProgressTask(state.tasks, current.id);
				if (active) {
					return errorResult(
						state,
						`cannot start #${current.id}: #${active.id} is already in_progress; complete or re-queue #${active.id} before starting #${current.id}`,
					);
				}
				const blockerId = firstIncompleteDependencyId(state.tasks, newBlockedBy);
				if (blockerId) return errorResult(state, `#${current.id} is blocked by incomplete task #${blockerId}`);
			}
			if (newStatus === "completed") {
				const blockerId = firstIncompleteDependencyId(state.tasks, newBlockedBy);
				if (blockerId) return errorResult(state, `#${current.id} is blocked by incomplete task #${blockerId}`);
			}

			let newMetadata = current.metadata;
			if (params.metadata !== undefined) {
				const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
				for (const [k, v] of Object.entries(params.metadata)) {
					if (v === null) delete merged[k];
					else merged[k] = v;
				}
				newMetadata = Object.keys(merged).length ? merged : undefined;
			}

			const updated: Task = { ...current, status: newStatus };
			if (params.subject !== undefined) updated.subject = params.subject;
			if (params.description !== undefined) updated.description = params.description;
			if (params.owner !== undefined) updated.owner = params.owner;
			if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
			else delete updated.blockedBy;
			if (newMetadata === undefined) delete updated.metadata;
			else updated.metadata = newMetadata;

			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: { kind: "update", id: updated.id, fromStatus: current.status, toStatus: newStatus },
			};
		}

		case "batch": {
			if (!params.operations?.length) return errorResult(state, "operations required for batch");
			if (params.operations.length > 50) return errorResult(state, "batch supports at most 50 operations");

			let nextState = state;
			const operations: BatchItemOp[] = [];
			for (const [index, operation] of params.operations.entries()) {
				const result = applyTaskMutation(nextState, operation.action, operation);
				if (result.op.kind === "error") {
					return errorResult(
						state,
						`batch operation ${index + 1} (${formatBatchOperation(operation)}): ${result.op.message}`,
					);
				}
				switch (result.op.kind) {
					case "create":
					case "update":
					case "delete":
						operations.push(result.op);
						break;
					default:
						return errorResult(state, `batch operation ${index + 1}: unsupported action ${operation.action}`);
				}
				nextState = result.state;
			}
			return { state: nextState, op: { kind: "batch", operations } };
		}

		case "list": {
			return {
				state,
				op: {
					kind: "list",
					includeDeleted: params.includeDeleted === true,
					...(params.status !== undefined ? { statusFilter: params.status } : {}),
				},
			};
		}

		case "get": {
			if (params.id === undefined) return errorResult(state, "id required for get");
			const task = state.tasks.find((t) => t.id === params.id);
			if (!task) return errorResult(state, `#${params.id} not found`);
			return { state, op: { kind: "get", task } };
		}

		case "delete": {
			if (params.id === undefined) return errorResult(state, "id required for delete");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];
			if (current.status === "deleted") return errorResult(state, `#${current.id} is already deleted`);
			const updated: Task = { ...current, status: "deleted" };
			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: { kind: "delete", id: updated.id, subject: updated.subject },
			};
		}

		case "clear": {
			const count = state.tasks.length;
			return {
				state: { tasks: [], nextId: 1 },
				op: { kind: "clear", count },
			};
		}
	}
}
