import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Task, TaskAction, TaskDetails, TaskMutationParams, TaskStatus } from "../tool/types.js";

// Re-export so legacy import paths continue to resolve; the canonical
// definition lives in the i18n bridge.
export { formatStatusLabel } from "../state/i18n-bridge.js";

/**
 * Glyph for the persistent overlay's per-task row. The overlay normally omits
 * deleted rows but retains an error-toned `✗` fallback for defensive callers.
 * Mirrors pre-refactor `todo-overlay.ts:23-33`.
 */
export function overlayStatusGlyph(status: TaskStatus, theme: Theme): string {
	switch (status) {
		case "pending":
			return theme.fg("dim", "○");
		case "in_progress":
			return theme.fg("warning", "◐");
		case "completed":
			return theme.fg("success", "✓");
		case "deleted":
			return theme.fg("error", "✗");
	}
}

/**
 * Format a single task for the overlay (with theme + glyph + dep suffix).
 * Used by `TodoOverlay.formatTaskLine` post-refactor; behavior is unchanged.
 */
export function formatOverlayTaskLine(t: Task, theme: Theme, showId: boolean): string {
	const glyph = overlayStatusGlyph(t.status, theme);
	const subjectColor = t.status === "completed" || t.status === "deleted" ? "dim" : "text";
	let subject = theme.fg(subjectColor, t.subject);
	if (t.status === "completed" || t.status === "deleted") {
		subject = theme.strikethrough(subject);
	}
	let line = `${glyph}`;
	if (showId) line += ` ${theme.fg("accent", `#${t.id}`)}`;
	line += ` ${subject}`;
	if (t.status === "in_progress" && t.activeForm) {
		line += ` ${theme.fg("dim", `(${t.activeForm})`)}`;
	}
	if (t.blockedBy && t.blockedBy.length > 0) {
		line += ` ${theme.fg("dim", `⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
	}
	return line;
}

/**
 * Format a single task line for the `/todos` slash command (no glyph color,
 * indented bullet prefix). Pre-refactor `todo.ts:670-674`.
 */
export function formatCommandTaskLine(t: Task, glyph: string): string {
	const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
	const block = t.blockedBy?.length ? `    ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	return `  ${glyph} #${t.id} ${t.subject}${form}${block}`;
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

function formatTodoCallSummary(args: TodoCallArgs): string {
	switch (args.action) {
		case "create":
			return `create${args.subject ? ` “${args.subject}”` : ""}`;
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
		case "batch":
			return `batch (${args.operations?.length ?? 0} operations)`;
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
