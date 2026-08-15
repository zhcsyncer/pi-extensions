import type { TaskState } from "../state/state.js";
import type { Op } from "../state/state-reducer.js";
import type {
	MutationDetailsV2,
	QueryDetailsV2,
	Task,
	TaskAction,
	TaskBatchOperation,
	TaskDetails,
	TaskMutationAction,
	TaskMutationParams,
} from "./types.js";

function formatListLine(task: Task): string {
	return `[${task.status}] #${task.id} ${task.subject}`;
}

function formatGetLines(task: Task): string {
	const lines = [`#${task.id} [${task.status}] ${task.subject}`];
	if (task.description) lines.push(`  description: ${task.description}`);
	if (task.owner) lines.push(`  owner: ${task.owner}`);
	return lines.join("\n");
}

function formatList(op: Extract<Op, { kind: "list" }>, state: TaskState): string {
	if (op.statusFilter) {
		const filtered = state.tasks.filter((task) => task.status === op.statusFilter);
		return filtered.length === 0 ? "No tasks" : filtered.map(formatListLine).join("\n");
	}

	if (op.includeDeleted) {
		return state.tasks.length === 0 ? "No tasks" : state.tasks.map(formatListLine).join("\n");
	}

	const active = state.tasks.filter(
		(task) => task.status === "pending" || task.status === "in_progress",
	);
	const completedCount = state.tasks.filter((task) => task.status === "completed").length;
	const lines = active.map(formatListLine);
	if (completedCount > 0) {
		lines.push(`${completedCount} completed ${completedCount === 1 ? "task" : "tasks"} hidden`);
	}
	return lines.length === 0 ? "No tasks" : lines.join("\n");
}

/** Pure formatter for the model-visible text portion of a Todo result. */
export function formatContent(op: Op, state: TaskState): string {
	switch (op.kind) {
		case "create": {
			const task = state.tasks.find((candidate) => candidate.id === op.taskId);
			if (!task) return `Created #${op.taskId} (${op.status})`;
			return `Created #${task.id}: ${task.subject} (${op.status})`;
		}
		case "update": {
			const transition = op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : "";
			return `Updated #${op.id}${transition}`;
		}
		case "delete":
			return `Deleted #${op.id}: ${op.subject}`;
		case "list":
			return formatList(op, state);
		case "get":
			return formatGetLines(op.task);
		case "batch":
			return [
				`Applied ${op.operations.length} todo operations`,
				...op.operations.map((operation) => `- ${formatContent(operation, state)}`),
			].join("\n");
		case "error":
			return `Error: ${op.message}`;
	}
}

export interface TodoToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: TaskDetails;
}

function copyDefined(
	target: Record<string, unknown>,
	source: TaskMutationParams,
	keys: readonly (keyof TaskMutationParams)[],
): void {
	for (const key of keys) {
		if (source[key] !== undefined) target[key] = source[key];
	}
}

function sanitizeBatchOperation(operation: TaskBatchOperation): Record<string, unknown> {
	const sanitized: Record<string, unknown> = { action: operation.action };
	switch (operation.action) {
		case "create":
			copyDefined(sanitized, operation, ["subject", "description", "status", "owner", "metadata"]);
			break;
		case "update":
			copyDefined(sanitized, operation, ["id", "subject", "description", "status", "owner", "metadata"]);
			break;
		case "delete":
			copyDefined(sanitized, operation, ["id"]);
			break;
	}
	return sanitized;
}

function sanitizeMutationParams(
	action: TaskMutationAction,
	params: TaskMutationParams,
): Record<string, unknown> {
	const sanitized: Record<string, unknown> = {};
	if (params.action !== undefined) sanitized.action = action;
	switch (action) {
		case "create":
			copyDefined(sanitized, params, ["subject", "description", "status", "owner", "metadata"]);
			break;
		case "update":
			copyDefined(sanitized, params, ["id", "subject", "description", "status", "owner", "metadata"]);
			break;
		case "delete":
			copyDefined(sanitized, params, ["id"]);
			break;
		case "batch":
			if (params.operations !== undefined) {
				sanitized.operations = params.operations.map(sanitizeBatchOperation);
			}
			break;
	}
	return sanitized;
}

/**
 * Mutations emit V2 replay checkpoints with action-scoped current parameters.
 * Queries emit only a small discriminator, so repeated list/get calls do not
 * duplicate the live task state in JSONL.
 */
export function buildToolResult(
	action: TaskAction,
	params: TaskMutationParams,
	state: TaskState,
	op: Op,
): TodoToolResult {
	const content = [{ type: "text" as const, text: formatContent(op, state) }];
	if (action === "list" || action === "get") {
		const details: QueryDetailsV2 = {
			schemaVersion: 2,
			kind: "query",
			action,
		};
		return { content, details };
	}

	const details: MutationDetailsV2 = {
		schemaVersion: 2,
		kind: "checkpoint",
		action,
		params: sanitizeMutationParams(action, params),
		state,
	};
	return { content, details };
}
