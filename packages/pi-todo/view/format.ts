import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Task, TaskDetails, TaskStatus } from "../tool/types.js";

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
 * transcript node intentionally renders no lines. `renderShell: "self"` on
 * the tool definition lets Pi collapse the surrounding tool shell as well.
 */
export function renderHiddenTodoNode(): Text {
	return new Text("", 0, 0);
}

type TodoRenderResult = {
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
};

/**
 * Keep successful results invisible while surfacing both reducer-level errors
 * (`details.error`) and failures reported by Pi (`isError`). The structured
 * result remains in the session even when this component renders zero lines.
 */
export function renderTodoResult(result: TodoRenderResult, theme: Theme, isError = false): Text {
	const details = result.details as TaskDetails | undefined;
	const failureText = details?.error ?? (
		isError
			? result.content?.find((item) => item.type === "text" && item.text)?.text ?? "Todo failed"
			: undefined
	);
	return failureText
		? new Text(theme.fg("error", `✗ ${failureText}`), 0, 0)
		: renderHiddenTodoNode();
}
