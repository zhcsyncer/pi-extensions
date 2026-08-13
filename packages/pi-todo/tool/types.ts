import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { TaskState } from "../state/state.js";

// ---------------------------------------------------------------------------
// Tool identity — verbatim string boundary. Tool name "todo" is the
// persistence key for branch replay (filtering `toolResult.toolName ===
// "todo"`) AND the permissions entry at `templates/pi-permissions.jsonc:26`.
// DO NOT rename.
// ---------------------------------------------------------------------------

export const TOOL_NAME = "todo";
export const TOOL_LABEL = "Todo";

// ---------------------------------------------------------------------------
// Public domain types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TaskMutationAction = "create" | "update" | "delete" | "batch";
export type TaskQueryAction = "list" | "get";
export type TaskAction = TaskMutationAction | TaskQueryAction;
export type LegacyTaskAction = TaskAction | "clear";
export type TaskBatchOperationAction = Exclude<TaskMutationAction, "batch">;

export interface Task {
	id: number;
	subject: string;
	description?: string;
	status: TaskStatus;
	owner?: string;
	metadata?: Record<string, unknown>;
}

/** Legacy full-state snapshot emitted by pi-todo V1. */
export interface TaskDetailsV1 {
	/** Missing only on snapshots written before schema versioning. */
	schemaVersion?: 1;
	action: LegacyTaskAction;
	params: Record<string, unknown>;
	tasks: Task[];
	nextId: number;
	error?: string;
}

/** V2 mutation results remain branch-aware replay checkpoints. */
export interface MutationDetailsV2 {
	schemaVersion: 2;
	kind: "checkpoint";
	action: TaskMutationAction;
	params: Record<string, unknown>;
	state: TaskState;
}

/** V2 query results deliberately carry no replayable task state. */
export interface QueryDetailsV2 {
	schemaVersion: 2;
	kind: "query";
	action: TaskQueryAction;
}

/** Branch-scoped custom checkpoint written by the user-confirmed reset UI. */
export interface ResetDetailsV2 {
	schemaVersion: 2;
	kind: "checkpoint";
	action: "reset";
	state: TaskState;
}

export type TaskDetails = TaskDetailsV1 | MutationDetailsV2 | QueryDetailsV2;

/**
 * Open-shape input bag the reducer accepts. Stays an interface so the index
 * signature (`[key: string]: unknown`) lets the runtime pass through TypeBox
 * `Static<typeof TodoParamsSchema>` without `as` casts.
 */
export interface TaskBatchOperation extends TaskMutationParams {
	action: TaskBatchOperationAction;
}

export interface TaskMutationParams {
	[key: string]: unknown;
	subject?: string;
	description?: string;
	status?: TaskStatus;
	owner?: string;
	metadata?: Record<string, unknown>;
	id?: number;
	includeDeleted?: boolean;
	operations?: TaskBatchOperation[];
}

// ---------------------------------------------------------------------------
// TypeBox parameter schema — every `description` doubles as LLM-facing prompt
// copy. Keep action-specific constraints explicit because the Google-compatible
// flat schema cannot express them with Type.Union/Type.Literal discriminators.
// ---------------------------------------------------------------------------

const TodoBatchOperationSchema = Type.Object({
	action: StringEnum(["create", "update", "delete"] as const),
	subject: Type.Optional(Type.String({ description: "Task subject line (required for create)" })),
	description: Type.Optional(Type.String({ description: "Long-form task description" })),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
			description: "Initial create status (pending default; create accepts only pending or in_progress) or update target",
		}),
	),
	owner: Type.Optional(Type.String()),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	id: Type.Optional(Type.Number()),
});

export const TodoParamsSchema = Type.Object({
	action: StringEnum(["create", "update", "list", "get", "delete", "batch"] as const),
	subject: Type.Optional(Type.String({ description: "Task subject line (required for create)" })),
	description: Type.Optional(Type.String({ description: "Long-form task description" })),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
			description:
				"Initial status for create (pending default; create accepts only pending or in_progress), target status for update, or list filter",
		}),
	),
	owner: Type.Optional(Type.String({ description: "Agent/owner assigned to this task" })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Arbitrary metadata; pass null value for a key to delete that key on update",
		}),
	),
	id: Type.Optional(
		Type.Number({
			description: "Task id (required for update, get, delete)",
		}),
	),
	includeDeleted: Type.Optional(
		Type.Boolean({
			description:
				"If true and no status filter is set, list returns all live-state statuses. Explicit status filters can query completed or deleted directly. Default: false.",
		}),
	),
	operations: Type.Optional(
		Type.Array(TodoBatchOperationSchema, {
			minItems: 1,
			maxItems: 50,
			description:
				"Ordered atomic create/update/delete operations. To start a fresh cycle, include at least two create operations in intended execution order: set the first to in_progress and leave the rest pending. Each operation sees prior results and all roll back if one fails. Complete or re-queue the active task before starting another.",
		}),
	),
});

export type TodoParams = Static<typeof TodoParamsSchema>;
