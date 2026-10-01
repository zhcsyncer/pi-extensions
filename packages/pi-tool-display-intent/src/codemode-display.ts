import { formatSize, highlightCode } from "@earendil-works/pi-coding-agent";
import {
	Text,
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";
import {
	extractCodemodeCommentIntent,
	extractCodemodeToolCalls,
	resolveDisplaySummaryForTool,
} from "./display-summary-fallback.js";
import { registerCleanup, registerTimer } from "./disposable.js";
import { shouldShowDeterministicFallback } from "./live-tool-call.js";
import { layoutPreviewRows } from "./preview-text.js";
import {
	compactOutputLines,
	extractTextOutput,
	pluralize,
	splitLines,
} from "./render-utils.js";
import {
	formatClaudeStatusMarker,
	formatClaudeToolCall,
} from "./tool-call-style.js";
import type { ToolCallStyle, ToolDisplayConfig, ToolIntentConfig } from "./types.js";

const CODEMODE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const CODEMODE_SPINNER_INTERVAL_MS = 200;
const CODEMODE_SPINNER_STATE_KEY = "__piToolDisplayIntentCodemodeSpinner";
const CODEMODE_SPINNER_TOOL_CALL_ID_KEY = "__piToolDisplayIntentCodemodeSpinnerToolCallId";
const MAX_HIGHLIGHTED_CODE_CHARS = 50_000;
const MAX_HIGHLIGHTED_CODE_LINES = 1_000;

export interface NestedToolCallRecord {
	name: string;
	arguments?: Record<string, unknown>;
	argumentsBytes?: number;
	durationMs?: number;
	status: "ok" | "error" | "unfinished";
	error?: string;
}

export interface CodemodeNestedCalls {
	complete?: boolean;
	calls?: NestedToolCallRecord[];
}

export interface CodemodeCallArgs {
	code?: string;
	displaySummary?: unknown;
}

interface CodemodeCallRenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface CodemodeSpinnerState {
	frameIndex: number;
	startedAt?: number;
	timer?: ReturnType<typeof setInterval>;
}

interface CodemodeSpinnerStateCarrier {
	[CODEMODE_SPINNER_STATE_KEY]?: CodemodeSpinnerState;
	[CODEMODE_SPINNER_TOOL_CALL_ID_KEY]?: string;
}

export interface CodemodeCallRenderContextLike {
	executionStarted: boolean;
	argsComplete?: boolean;
	expanded?: boolean;
	isError?: boolean;
	isPartial: boolean;
	invalidate?: () => void;
	lastComponent?: unknown;
	state?: unknown;
	toolCallId?: string;
}

const spinnerStatesByToolCallId = new Map<string, CodemodeSpinnerState>();
let nextSyntheticToolCallId = 0;

function toStateCarrier(value: unknown): CodemodeSpinnerStateCarrier | undefined {
	if (!value || typeof value !== "object") return undefined;
	return value as CodemodeSpinnerStateCarrier;
}

function getSyntheticToolCallId(carrier: CodemodeSpinnerStateCarrier | undefined): string | undefined {
	if (!carrier) return undefined;
	if (!carrier[CODEMODE_SPINNER_TOOL_CALL_ID_KEY]) {
		carrier[CODEMODE_SPINNER_TOOL_CALL_ID_KEY] = `codemode-state:${++nextSyntheticToolCallId}`;
	}
	return carrier[CODEMODE_SPINNER_TOOL_CALL_ID_KEY];
}

function getToolCallId(context: CodemodeCallRenderContextLike): string | undefined {
	if (typeof context.toolCallId === "string" && context.toolCallId.trim().length > 0) {
		return context.toolCallId;
	}
	return getSyntheticToolCallId(toStateCarrier(context.state));
}

function getOrCreateSpinnerState(
	toolCallId: string | undefined,
	carrier: CodemodeSpinnerStateCarrier | undefined,
): CodemodeSpinnerState | undefined {
	if (!toolCallId) return undefined;
	let state = spinnerStatesByToolCallId.get(toolCallId);
	if (!state) {
		state = { frameIndex: 0 };
		spinnerStatesByToolCallId.set(toolCallId, state);
	}
	if (carrier) {
		carrier[CODEMODE_SPINNER_STATE_KEY] = state;
	}
	return state;
}

function stopSpinner(toolCallId: string | undefined, state: CodemodeSpinnerState | undefined): void {
	if (!state) return;
	if (state.timer) {
		clearInterval(state.timer);
		state.timer = undefined;
	}
	state.frameIndex = 0;
	state.startedAt = undefined;
	if (toolCallId) {
		spinnerStatesByToolCallId.delete(toolCallId);
	}
}

function formatElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const remainingSeconds = totalSeconds % 60;
	return `${minutes}m${remainingSeconds.toString().padStart(2, "0")}s`;
}

registerCleanup(() => {
	for (const [toolCallId, state] of spinnerStatesByToolCallId) {
		stopSpinner(toolCallId, state);
	}
	spinnerStatesByToolCallId.clear();
});

export function stripOptionsLine(code: string): string {
	const lines = code.replace(/\r\n?/g, "\n").split("\n");
	while (lines.length > 0 && lines[0]?.trim() === "") {
		lines.shift();
	}
	if (lines.length > 0 && lines[0]?.trim().startsWith("// @options:")) {
		lines.shift();
	}
	return lines.join("\n").trim();
}

function highlightExpandedCode(codeDisplay: string): string {
	if (
		codeDisplay.length > MAX_HIGHLIGHTED_CODE_CHARS ||
		codeDisplay.split("\n").length > MAX_HIGHLIGHTED_CODE_LINES
	) {
		return codeDisplay;
	}
	try {
		return highlightCode(codeDisplay, "typescript").join("\n");
	} catch {
		return codeDisplay;
	}
}

export function formatNestedCallsSummary(
	nested: CodemodeNestedCalls | undefined,
	theme: CodemodeCallRenderTheme,
): string {
	if (!nested || !Array.isArray(nested.calls) || nested.calls.length === 0) return "";
	const countsByTool = new Map<string, { ok: number; error: number; unfinished: number }>();
	for (const call of nested.calls) {
		if (!call || typeof call !== "object") continue;
		const name = call.name || "tool";
		const existing = countsByTool.get(name) ?? { ok: 0, error: 0, unfinished: 0 };
		if (call.status === "error") {
			existing.error += 1;
		} else if (call.status === "unfinished") {
			existing.unfinished += 1;
		} else {
			existing.ok += 1;
		}
		countsByTool.set(name, existing);
	}

	const parts: string[] = [];
	for (const [name, stats] of countsByTool) {
		if (stats.ok > 0 && stats.error === 0 && stats.unfinished === 0) {
			parts.push(theme.fg("success", `✓ ${name} ×${stats.ok}`));
		} else if (stats.error > 0 && stats.ok === 0 && stats.unfinished === 0) {
			parts.push(theme.fg("error", `✗ ${name} ×${stats.error}`));
		} else if (stats.unfinished > 0 && stats.ok === 0 && stats.error === 0) {
			parts.push(theme.fg("warning", `… ${name} ×${stats.unfinished}`));
		} else {
			const subParts: string[] = [];
			if (stats.ok > 0) subParts.push(theme.fg("success", `✓ ${name} ×${stats.ok}`));
			if (stats.error > 0) subParts.push(theme.fg("error", `✗ ${name} ×${stats.error}`));
			if (stats.unfinished > 0) subParts.push(theme.fg("warning", `… ${name} ×${stats.unfinished}`));
			parts.push(subParts.join(" · "));
		}
	}

	const totalCount = nested.calls.length;
	const countLabel = `${totalCount} ${pluralize(totalCount, "nested call", "nested calls")}`;
	return `${theme.fg("muted", `Nested (${countLabel}):`)} ${parts.join(theme.fg("muted", " · "))}`;
}

export function formatNestedCallsDetail(
	nested: CodemodeNestedCalls | undefined,
	theme: CodemodeCallRenderTheme,
): string[] {
	if (!nested || !Array.isArray(nested.calls) || nested.calls.length === 0) return [];
	const rows: string[] = [];
	for (const call of nested.calls) {
		if (!call || typeof call !== "object") continue;
		const icon = call.status === "error"
			? theme.fg("error", "✗")
			: call.status === "unfinished"
				? theme.fg("warning", "…")
				: theme.fg("success", "✓");
		const name = theme.bold(call.name || "tool");
		const duration = call.durationMs !== undefined ? theme.fg("dim", ` ${call.durationMs}ms`) : "";
		let argsSummary = "";
		if (call.arguments && typeof call.arguments === "object") {
			const keys = Object.keys(call.arguments);
			if (keys.length === 1 && typeof call.arguments[keys[0]!] === "string") {
				argsSummary = ` ${call.arguments[keys[0]!]}`;
			} else if (keys.length > 0) {
				argsSummary = ` ${JSON.stringify(call.arguments)}`;
			}
			if (argsSummary.length > 80) argsSummary = `${argsSummary.slice(0, 77)}…`;
		}
		rows.push(`  ${icon} ${name}${argsSummary}${duration}`);
		if (call.error) {
			const errorLines = String(call.error).split("\n").slice(0, 2);
			for (const errLine of errorLines) {
				rows.push(`    ${theme.fg("error", errLine)}`);
			}
		}
	}
	return rows;
}

export function renderCodemodeCall(
	args: CodemodeCallArgs,
	theme: CodemodeCallRenderTheme,
	context: CodemodeCallRenderContextLike,
	toolIntentConfig?: ToolIntentConfig,
	toolCallStyle: ToolCallStyle = "compact",
): Component {
	const toolCallId = getToolCallId(context);
	const carrier = toStateCarrier(context.state);
	const spinnerState = getOrCreateSpinnerState(toolCallId, carrier);
	const shouldSpin = context.executionStarted && context.isPartial;

	let spinnerFrame: string | undefined;
	let elapsedMs: number | undefined;

	if (shouldSpin && spinnerState) {
		spinnerState.startedAt ??= Date.now();
		elapsedMs = Math.max(0, Date.now() - spinnerState.startedAt);
		spinnerFrame = CODEMODE_SPINNER_FRAMES[spinnerState.frameIndex % CODEMODE_SPINNER_FRAMES.length];

		if (!spinnerState.timer && context.invalidate) {
			const invoker = context.invalidate;
			spinnerState.timer = setInterval(() => {
				if (!spinnerStatesByToolCallId.has(toolCallId ?? "")) {
					stopSpinner(toolCallId, spinnerState);
					return;
				}
				spinnerState.frameIndex = (spinnerState.frameIndex + 1) % CODEMODE_SPINNER_FRAMES.length;
				invoker();
			}, CODEMODE_SPINNER_INTERVAL_MS);
			registerTimer(spinnerState.timer);
			registerCleanup(() => {
				if (spinnerStatesByToolCallId.get(toolCallId ?? "") === spinnerState) {
					stopSpinner(toolCallId, spinnerState);
				}
			});
		}
	} else {
		stopSpinner(toolCallId, spinnerState);
	}

	const rawCode = typeof args.code === "string" ? args.code : "";
	const cleanedCode = stripOptionsLine(rawCode);

	let intentSuffix = "";
	if (toolIntentConfig) {
		const resolved = resolveDisplaySummaryForTool(args, "codemode", toolIntentConfig);
		const showIntent = resolved && (resolved.source === "model" || shouldShowDeterministicFallback(context));
		if (showIntent && resolved) {
			const color = resolved.source === "model" ? "accent" : "muted";
			intentSuffix = `${theme.fg("muted", " — ")}${theme.fg(color, resolved.text)}`;
		}
	}

	const elapsedSuffix = elapsedMs !== undefined && elapsedMs >= 1000
		? theme.fg("muted", ` (${formatElapsed(elapsedMs)})`)
		: "";

	const allLines = cleanedCode.split("\n");
	const nonCommentLines = allLines.filter((l) => {
		const t = l.trim();
		return t && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("*");
	});
	let firstLine = allLines[0]?.trim() ?? "";
	if (intentSuffix) {
		if (nonCommentLines.length > 0) {
			firstLine = nonCommentLines[0]?.trim() ?? "";
		} else {
			intentSuffix = "";
		}
	}

	if (toolCallStyle === "claude") {
		const renderedCode = context.expanded
			? highlightExpandedCode(cleanedCode)
			: theme.fg("text", firstLine);
		return new Text(
			formatClaudeToolCall("codemode", renderedCode, elapsedSuffix, intentSuffix, theme, context, spinnerFrame),
			0,
			0,
		);
	}

	// Compact individual layout
	if (context.expanded) {
		const highlighted = highlightExpandedCode(cleanedCode);
		const header = `${theme.fg("toolTitle", theme.bold("codemode"))}${intentSuffix}${elapsedSuffix}`;
		return new Text(`${header}\n${highlighted}`, 0, 0);
	}

	const lineCount = allLines.filter((l) => l.trim().length > 0).length;
	const countSuffix = lineCount > 1 ? theme.fg("dim", ` (${lineCount} lines · Ctrl+O)`) : "";
	const spinnerPrefix = spinnerFrame ? `${spinnerFrame} ` : "";
	const firstLineDisplay = firstLine ? ` ${theme.fg("accent", firstLine)}` : "";
	const header = `${spinnerPrefix}${theme.fg("toolTitle", theme.bold("codemode"))}${firstLineDisplay}${countSuffix}${intentSuffix}${elapsedSuffix}`;

	return new Text(header, 0, 0);
}

export class CodemodeResultComponent implements Component {
	constructor(
		private readonly nestedSummary: string,
		private readonly lines: string[],
		private readonly maxRows: number,
		private readonly theme: CodemodeCallRenderTheme,
		private readonly expanded: boolean,
		private readonly nestedDetailLines?: string[],
	) {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		if (this.expanded) {
			const parts: string[] = [];
			if (this.nestedSummary) {
				parts.push(this.nestedSummary);
			}
			if (this.nestedDetailLines && this.nestedDetailLines.length > 0) {
				parts.push(...this.nestedDetailLines);
			}
			if (this.lines.length > 0) {
				parts.push(this.theme.fg("muted", "--- Output ---"));
				parts.push(...this.lines);
			}
			if (parts.length === 0) {
				parts.push(this.theme.fg("success", "Script completed (no output)"));
			}
			return new Text(parts.join("\n"), 0, 0).render(safeWidth);
		}

		const parts: string[] = [];
		if (this.nestedSummary) {
			parts.push(this.nestedSummary);
		}
		const previewLayout = layoutPreviewRows(this.lines, this.maxRows, safeWidth);
		if (previewLayout.rows.length > 0) {
			parts.push(...previewLayout.rows);
			if (previewLayout.hiddenLineCount > 0) {
				parts.push(this.theme.fg("muted", `... (${previewLayout.hiddenLineCount} more rows · Ctrl+O)`));
			}
		} else if (parts.length === 0) {
			parts.push(this.theme.fg("success", "Script completed (no output)"));
		}
		return new Text(parts.join("\n"), 0, 0).render(safeWidth);
	}

	invalidate(): void {}
}

export function renderCodemodeResult(
	result: Record<string, unknown>,
	options: { expanded?: boolean; isPartial?: boolean },
	config: ToolDisplayConfig,
	theme: CodemodeCallRenderTheme,
	context?: CodemodeCallRenderContextLike,
): Component {
	if (options.isPartial) {
		return new Text(theme.fg("warning", "Executing script..."), 0, 0);
	}

	const isError = Boolean(
		(result && typeof result === "object" && result.isError === true) ||
		context?.isError === true,
	);
	const rawOutput = extractTextOutput(result);
	const resObj = (result && typeof result === "object") ? result : {};
	const nested = (resObj.nestedCalls ?? (resObj.details as Record<string, unknown> | undefined)?.nestedCalls) as CodemodeNestedCalls | undefined;
	const nestedSummary = formatNestedCallsSummary(nested, theme);

	if (isError) {
		const parts: string[] = [];
		if (nestedSummary) {
			parts.push(nestedSummary);
		}
		if (options.expanded && nested?.calls && nested.calls.length > 0) {
			parts.push(...formatNestedCallsDetail(nested, theme));
		}
		let errorHeader = theme.fg("error", "Script failed.");
		if (rawOutput) {
			errorHeader += `\n${theme.fg("error", rawOutput)}`;
		}
		parts.push(errorHeader);
		return new Text(parts.join("\n"), 0, 0);
	}

	const lines = compactOutputLines(splitLines(rawOutput), { expanded: options.expanded ?? false });

	if (options.expanded) {
		const detailLines = nested?.calls && nested.calls.length > 0
			? formatNestedCallsDetail(nested, theme)
			: undefined;
		return new CodemodeResultComponent(
			nestedSummary,
			lines,
			config.expandedPreviewMaxRows,
			theme,
			true,
			detailLines,
		);
	}

	// Collapsed mode
	if (config.resultMode === "compact") {
		const statusText = theme.fg("success", "Script completed");
		const summaryText = nestedSummary ? `${statusText} · ${nestedSummary}` : statusText;
		return new Text(summaryText, 0, 0);
	}

	// Preview or summary mode
	return new CodemodeResultComponent(
		nestedSummary,
		lines,
		config.previewRows,
		theme,
		false,
	);
}
