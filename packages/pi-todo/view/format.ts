import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { StatusIcons } from "../config.js";
import type { Task, TaskAction, TaskDetails, TaskMutationParams, TaskStatus } from "../tool/types.js";

// Re-export so legacy import paths continue to resolve; the canonical
// definition lives in the i18n bridge.
export { formatStatusLabel } from "../state/i18n-bridge.js";

/**
 * Theme-aware status symbol for overlay and command rows. Icon shape comes
 * from the configured preset; semantic colors always come from Pi's theme.
 */
export function statusIcon(
	status: TaskStatus,
	theme: Theme,
	icons: StatusIcons,
	inProgressFrame = icons.inProgressFrames[0]!,
): string {
	switch (status) {
		case "pending":
			return theme.fg("dim", icons.pending);
		case "in_progress":
			return theme.fg("accent", inProgressFrame);
		case "completed":
			return theme.fg("success", icons.completed);
		case "deleted":
			return theme.fg("error", icons.deleted);
	}
}

function formatTaskSubject(task: Task, theme: Theme): string {
	switch (task.status) {
		case "pending":
			return theme.fg("muted", task.subject);
		case "in_progress":
			return theme.fg("accent", theme.bold(task.subject));
		case "completed":
			return theme.fg("dim", theme.strikethrough(task.subject));
		case "deleted":
			return theme.fg("error", theme.strikethrough(task.subject));
	}
}

function formatTaskId(task: Task, theme: Theme): string {
	return theme.fg(task.status === "in_progress" ? "accent" : "dim", `#${task.id}`);
}

/** Format a single task for the overlay with status-aware theme styling. */
export function formatOverlayTaskLine(
	t: Task,
	theme: Theme,
	showId: boolean,
	icons: StatusIcons,
	inProgressFrame?: string,
): string {
	const glyph = statusIcon(t.status, theme, icons, inProgressFrame);
	let line = `${glyph}`;
	if (showId) line += ` ${formatTaskId(t, theme)}`;
	line += ` ${formatTaskSubject(t, theme)}`;
	if (t.blockedBy && t.blockedBy.length > 0) {
		line += ` ${theme.fg("dim", `⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
	}
	return line;
}

/**
 * Format a single task line for the `/todos` slash command (no glyph color,
 * indented bullet prefix). Pre-refactor `todo.ts:670-674`.
 */
export function formatCommandTaskLine(t: Task, glyph: string, theme: Theme): string {
	const block = t.blockedBy?.length
		? theme.fg("dim", `    ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`)
		: "";
	return `  ${glyph} ${formatTaskId(t, theme)} ${formatTaskSubject(t, theme)}${block}`;
}

// ---------------------------------------------------------------------------
// Tool render hooks
// ---------------------------------------------------------------------------

/**
 * Successful Todo calls are represented by the persistent widget, so their
 * transcript node renders no lines by default. Expanded mode uses the audit
 * renderers below. `renderShell: "self"` removes the surrounding tool shell.
 */
export function renderHiddenTodoNode(): Text {
	return new Text("", 0, 0);
}

type TodoCallArgs = TaskMutationParams & { action?: TaskAction };

function formatBatchCallOperation(operation: NonNullable<TaskMutationParams["operations"]>[number]): string {
	switch (operation.action) {
		case "create":
			return `create${operation.subject ? ` “${operation.subject}”` : ""}${operation.status ? ` → ${operation.status}` : ""}`;
		case "update":
			return `update${operation.id !== undefined ? ` #${operation.id}` : ""}${operation.status ? ` → ${operation.status}` : ""}`;
		case "delete":
			return `delete${operation.id !== undefined ? ` #${operation.id}` : ""}`;
	}
}

function formatTodoCallSummary(args: TodoCallArgs): string {
	switch (args.action) {
		case "create":
			return `create${args.subject ? ` “${args.subject}”` : ""}${args.status ? ` → ${args.status}` : ""}`;
		case "update":
			return `update${args.id !== undefined ? ` #${args.id}` : ""}${args.status ? ` → ${args.status}` : ""}`;
		case "delete":
			return `delete${args.id !== undefined ? ` #${args.id}` : ""}`;
		case "get":
			return `get${args.id !== undefined ? ` #${args.id}` : ""}`;
		case "list":
			return `list${args.status ? ` ${args.status}` : ""}`;
		case "clear":
			return "clear";
		case "batch": {
			const operations = args.operations ?? [];
			return [
				`batch (${operations.length} operations)`,
				...operations.map((operation, index) => `  ${index + 1}. ${formatBatchCallOperation(operation)}`),
			].join("\n");
		}
		default:
			return "todo";
	}
}

/** Successful calls stay hidden by default but become auditable in expanded mode. */
export function renderTodoCall(args: TodoCallArgs, theme: Theme, expanded = false): Text {
	if (!expanded) return renderHiddenTodoNode();
	return new Text(
		theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", formatTodoCallSummary(args)),
		0,
		0,
	);
}

type TodoRenderResult = {
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
};

/**
 * Keep successful results hidden by default, reveal them in expanded mode,
 * and surface both legacy reducer errors (`details.error`) and Pi execution
 * failures (`isError`). Structured results remain in the session either way.
 */
export function renderTodoResult(
	result: TodoRenderResult,
	theme: Theme,
	isError = false,
	expanded = false,
): Text {
	const details = result.details as TaskDetails | undefined;
	const resultText = result.content?.find((item) => item.type === "text" && item.text)?.text;
	const failureText = details?.error ?? (isError ? resultText ?? "Todo failed" : undefined);
	if (failureText) return new Text(theme.fg("error", `✗ ${failureText}`), 0, 0);
	if (expanded && resultText) return new Text(theme.fg("muted", resultText), 0, 0);
	return renderHiddenTodoNode();
}
