import { formatSize } from "@earendil-works/pi-coding-agent";
import {
	Text,
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";
import { resolveDisplaySummaryForTool } from "./display-summary-fallback.js";
import { registerCleanup, registerTimer } from "./disposable.js";
import { layoutPreviewRows } from "./preview-text.js";
import {
	formatClaudeStatusMarker,
	formatClaudeToolCall,
} from "./tool-call-style.js";
import type { ToolCallStyle, ToolIntentConfig } from "./types.js";

const BASH_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const BASH_SPINNER_INTERVAL_MS = 200;
const BASH_SPINNER_STATE_KEY = "__piToolDisplayIntentBashSpinner";
const BASH_SPINNER_TOOL_CALL_ID_KEY = "__piToolDisplayIntentBashSpinnerToolCallId";
const MIN_COLLAPSED_COMMAND_COLUMNS = 8;

interface BashCallArgs {
	command?: string;
	commandPrefix?: string;
	displaySummary?: unknown;
	shellPath?: string;
	timeout?: number;
}

type BashToolIntentConfig = ToolIntentConfig;

interface BashCallRenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface BashSpinnerState {
	frameIndex: number;
	startedAt?: number;
	timer?: ReturnType<typeof setInterval>;
}

interface BashSpinnerStateCarrier {
	[BASH_SPINNER_STATE_KEY]?: BashSpinnerState;
	[BASH_SPINNER_TOOL_CALL_ID_KEY]?: string;
}

interface BashCallRenderContextLike {
	executionStarted: boolean;
	expanded?: boolean;
	isError?: boolean;
	isPartial: boolean;
	invalidate?: () => void;
	lastComponent?: unknown;
	state?: unknown;
	toolCallId?: string;
}

interface BashCallViewState {
	args: BashCallArgs;
	theme: BashCallRenderTheme;
	spinnerFrame?: string;
	elapsedMs?: number;
	toolIntentConfig?: BashToolIntentConfig;
	toolCallStyle: ToolCallStyle;
	context: BashCallRenderContextLike;
	commandPreviewRows: number;
}

interface BashCallPresentation {
	commandDisplay: string;
	shellSuffix: string;
	timeoutSuffix: string;
	spinnerPrefix: string;
	elapsedSuffix: string;
	intentSuffix: string;
}

const spinnerStatesByToolCallId = new Map<string, BashSpinnerState>();
let nextSyntheticToolCallId = 0;

function toStateCarrier(value: unknown): BashSpinnerStateCarrier | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	return value as BashSpinnerStateCarrier;
}

function getSyntheticToolCallId(carrier: BashSpinnerStateCarrier | undefined): string | undefined {
	if (!carrier) {
		return undefined;
	}

	if (!carrier[BASH_SPINNER_TOOL_CALL_ID_KEY]) {
		carrier[BASH_SPINNER_TOOL_CALL_ID_KEY] = `state:${++nextSyntheticToolCallId}`;
	}
	return carrier[BASH_SPINNER_TOOL_CALL_ID_KEY];
}

function getToolCallId(context: BashCallRenderContextLike): string | undefined {
	if (typeof context.toolCallId === "string" && context.toolCallId.trim().length > 0) {
		return context.toolCallId;
	}
	return getSyntheticToolCallId(toStateCarrier(context.state));
}

function getOrCreateSpinnerState(
	toolCallId: string | undefined,
	carrier: BashSpinnerStateCarrier | undefined,
): BashSpinnerState | undefined {
	if (!toolCallId) {
		return undefined;
	}

	let state = spinnerStatesByToolCallId.get(toolCallId);
	if (!state) {
		state = { frameIndex: 0 };
		spinnerStatesByToolCallId.set(toolCallId, state);
	}
	if (carrier) {
		carrier[BASH_SPINNER_STATE_KEY] = state;
	}
	return state;
}

function stopSpinner(toolCallId: string | undefined, state: BashSpinnerState | undefined): void {
	if (!state) {
		return;
	}

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
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}

	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) {
		return `${totalMinutes}m ${seconds}s`;
	}

	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours}h ${minutes}m`;
}

function isDefaultShellPath(shellPath: string): boolean {
	const normalized = shellPath.trim().replace(/\\/g, "/").toLowerCase();
	const basename = normalized.split("/").pop() || normalized;
	return basename === "bash" || basename === "cmd.exe";
}

function buildCommandDisplay(args: BashCallArgs): string {
	const command =
		typeof args.command === "string" && args.command.trim().length > 0
			? args.command
			: "...";
	const prefix =
		typeof args.commandPrefix === "string" && args.commandPrefix.trim().length > 0
			? args.commandPrefix.trim()
			: "";
	return prefix ? `${prefix} ${command}` : command;
}

function buildBashCallPresentation(
	args: BashCallArgs,
	theme: BashCallRenderTheme,
	spinnerFrame?: string,
	elapsedMs?: number,
	toolIntentConfig?: BashToolIntentConfig,
): BashCallPresentation {
	const commandDisplay = buildCommandDisplay(args);
	const shellSuffix =
		typeof args.shellPath === "string" &&
		args.shellPath.trim().length > 0 &&
		!isDefaultShellPath(args.shellPath)
			? theme.fg("muted", ` [shell: ${args.shellPath}]`)
			: "";
	const timeoutSuffix = args.timeout
		? theme.fg("muted", ` (timeout ${args.timeout}s)`)
		: "";
	const spinnerPrefix = spinnerFrame ? `${theme.fg("warning", `${spinnerFrame} `)}` : "";
	const elapsedSuffix =
		spinnerFrame && elapsedMs !== undefined
			? theme.fg("muted", ` · ${formatElapsed(elapsedMs)}`)
			: "";
	const displaySummary = toolIntentConfig
		? resolveDisplaySummaryForTool(args, "bash", toolIntentConfig)
		: undefined;
	const intentSuffix = displaySummary
		? `${theme.fg("muted", " — ")}${theme.fg(displaySummary.source === "model" ? "accent" : "muted", displaySummary.text)}`
		: "";

	return {
		commandDisplay,
		shellSuffix,
		timeoutSuffix,
		spinnerPrefix,
		elapsedSuffix,
		intentSuffix,
	};
}

function buildExpandedBashCallText(
	presentation: BashCallPresentation,
	theme: BashCallRenderTheme,
	toolCallStyle: ToolCallStyle,
	context: BashCallRenderContextLike,
	spinnerFrame?: string,
): string {
	const {
		commandDisplay,
		shellSuffix,
		timeoutSuffix,
		spinnerPrefix,
		elapsedSuffix,
		intentSuffix,
	} = presentation;

	if (toolCallStyle === "claude") {
		return formatClaudeToolCall(
			"bash",
			theme.fg("text", commandDisplay),
			`${shellSuffix}${timeoutSuffix}${elapsedSuffix}`,
			intentSuffix,
			theme,
			context,
			spinnerFrame,
		);
	}

	return `${spinnerPrefix}${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("text", commandDisplay)}${shellSuffix}${timeoutSuffix}${elapsedSuffix}${intentSuffix}`;
}

function normalizeCommandLines(commandDisplay: string): string[] {
	return commandDisplay.replace(/\r\n?/g, "\n").split("\n");
}

function chooseCollapsedSuffix(commandDisplay: string, lineCount: number, contentWidth: number): string {
	const size = formatSize(Buffer.byteLength(commandDisplay, "utf8"));
	const candidates = lineCount > 1
		? [
			` … (${lineCount} lines · ${size} · Ctrl+O)`,
			` … (${lineCount} lines · Ctrl+O)`,
			` … (${lineCount} lines)`,
			" …",
		]
		: [
			` … (${size} · Ctrl+O)`,
			" … (Ctrl+O)",
			" …",
		];
	const suffixBudget = Math.max(0, contentWidth - MIN_COLLAPSED_COMMAND_COLUMNS);
	return candidates.find((candidate) => visibleWidth(candidate) <= suffixBudget)
		?? (contentWidth >= 2 ? " …" : "");
}

function buildCollapsedCommandRows(
	presentation: BashCallPresentation,
	theme: BashCallRenderTheme,
	toolCallStyle: ToolCallStyle,
	spinnerFrame: string | undefined,
	commandPreviewRows: number,
	width: number,
): string[] | undefined {
	const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
	const firstPrefixPlain = toolCallStyle === "claude"
		? "  $ "
		: `${spinnerFrame ? `${spinnerFrame} ` : ""}$ `;
	const continuationPrefixPlain = toolCallStyle === "claude" ? "    " : "  ";
	const prefixWidth = Math.max(
		visibleWidth(firstPrefixPlain),
		visibleWidth(continuationPrefixPlain),
	);
	const contentWidth = Math.max(1, safeWidth - prefixWidth);
	const lines = normalizeCommandLines(presentation.commandDisplay);
	const normalizedPreviewRows = Number.isFinite(commandPreviewRows)
		? Math.max(1, Math.floor(commandPreviewRows))
		: 1;
	const layout = layoutPreviewRows(lines, normalizedPreviewRows, contentWidth);
	const isCollapsed = layout.hiddenLineCount > 0 || layout.longLineTruncated || layout.rowLimitReached;
	if (!isCollapsed) {
		return undefined;
	}

	const rows = layout.rows.length > 0 ? [...layout.rows] : [""];
	const suffix = chooseCollapsedSuffix(presentation.commandDisplay, lines.length, contentWidth);
	const lastIndex = rows.length - 1;
	const lastContentWidth = Math.max(0, contentWidth - visibleWidth(suffix));
	rows[lastIndex] = `${truncateToWidth(rows[lastIndex] ?? "", lastContentWidth, "")}${suffix}`;

	const firstPrefix = toolCallStyle === "claude"
		? `${theme.fg("muted", "  ")}${theme.fg("toolTitle", theme.bold("$"))} `
		: `${presentation.spinnerPrefix}${theme.fg("toolTitle", theme.bold("$"))} `;
	const continuationPrefix = theme.fg("muted", continuationPrefixPlain);

	return rows.map((row, index) =>
		`${index === 0 ? firstPrefix : continuationPrefix}${theme.fg("text", row)}`,
	);
}

function buildCollapsedBashCallText(
	presentation: BashCallPresentation,
	theme: BashCallRenderTheme,
	toolCallStyle: ToolCallStyle,
	context: BashCallRenderContextLike,
	spinnerFrame: string | undefined,
	commandPreviewRows: number,
	width: number,
): string | undefined {
	if (context.expanded) {
		return undefined;
	}

	const commandRows = buildCollapsedCommandRows(
		presentation,
		theme,
		toolCallStyle,
		spinnerFrame,
		commandPreviewRows,
		width,
	);
	if (!commandRows) {
		return undefined;
	}

	const metadata = `${presentation.shellSuffix}${presentation.timeoutSuffix}${presentation.elapsedSuffix}`;
	if (toolCallStyle === "claude") {
		const marker = formatClaudeStatusMarker(theme, context, spinnerFrame);
		const header = `${marker} ${theme.fg("toolTitle", theme.bold("Bash"))}${metadata}${presentation.intentSuffix}`;
		return `${header}\n${commandRows.join("\n")}`;
	}

	const details = `${metadata}${presentation.intentSuffix}`;
	return details
		? `${commandRows.join("\n")}\n${theme.fg("muted", "  ")}${details}`
		: commandRows.join("\n");
}

export class BashCallComponent implements Component {
	private renderedContent?: string;
	private renderedText?: Text;

	constructor(private viewState: BashCallViewState) {}

	update(viewState: BashCallViewState): void {
		this.viewState = viewState;
	}

	render(width: number): string[] {
		const {
			args,
			theme,
			spinnerFrame,
			elapsedMs,
			toolIntentConfig,
			toolCallStyle,
			context,
			commandPreviewRows,
		} = this.viewState;
		const presentation = buildBashCallPresentation(
			args,
			theme,
			spinnerFrame,
			elapsedMs,
			toolIntentConfig,
		);
		const content = buildCollapsedBashCallText(
			presentation,
			theme,
			toolCallStyle,
			context,
			spinnerFrame,
			commandPreviewRows,
			width,
		) ?? buildExpandedBashCallText(
			presentation,
			theme,
			toolCallStyle,
			context,
			spinnerFrame,
		);
		if (!this.renderedText) {
			this.renderedText = new Text(content, 0, 0);
			this.renderedContent = content;
		} else if (this.renderedContent !== content) {
			this.renderedText.setText(content);
			this.renderedContent = content;
		}
		return this.renderedText.render(width);
	}

	invalidate(): void {
		this.renderedText?.invalidate();
		this.renderedContent = undefined;
		this.renderedText = undefined;
	}
}

function updateBashCallComponent(
	component: BashCallComponent,
	args: BashCallArgs,
	theme: BashCallRenderTheme,
	context: BashCallRenderContextLike,
	spinnerFrame: string | undefined,
	elapsedMs: number | undefined,
	toolIntentConfig: BashToolIntentConfig | undefined,
	toolCallStyle: ToolCallStyle,
	commandPreviewRows: number,
): void {
	component.update({
		args,
		theme,
		spinnerFrame,
		elapsedMs,
		toolIntentConfig,
		toolCallStyle,
		context,
		commandPreviewRows,
	});
}

export function renderBashCall(
	args: BashCallArgs,
	theme: BashCallRenderTheme,
	context: BashCallRenderContextLike,
	toolIntentConfig?: BashToolIntentConfig,
	toolCallStyle: ToolCallStyle = "compact",
	commandPreviewRows = 1,
): BashCallComponent {
	const component = context.lastComponent instanceof BashCallComponent
		? context.lastComponent
		: new BashCallComponent({
			args,
			theme,
			toolIntentConfig,
			toolCallStyle,
			context,
			commandPreviewRows,
		});
	const carrier = toStateCarrier(context.state);
	const toolCallId = getToolCallId(context);
	const spinnerState = getOrCreateSpinnerState(toolCallId, carrier);
	const shouldSpin = context.executionStarted && context.isPartial;

	if (!shouldSpin) {
		stopSpinner(toolCallId, spinnerState);
		updateBashCallComponent(
			component,
			args,
			theme,
			context,
			undefined,
			undefined,
			toolIntentConfig,
			toolCallStyle,
			commandPreviewRows,
		);
		return component;
	}

	if (spinnerState) {
		spinnerState.startedAt ??= Date.now();
		if (!spinnerState.timer && typeof context.invalidate === "function") {
			const timer = setInterval(() => {
				spinnerState.frameIndex = (spinnerState.frameIndex + 1) % BASH_SPINNER_FRAMES.length;
				updateBashCallComponent(
					component,
					args,
					theme,
					context,
					BASH_SPINNER_FRAMES[spinnerState.frameIndex],
					Date.now() - (spinnerState.startedAt ?? Date.now()),
					toolIntentConfig,
					toolCallStyle,
					commandPreviewRows,
				);
				context.invalidate?.();
			}, BASH_SPINNER_INTERVAL_MS);
			spinnerState.timer = timer;
			registerTimer(timer);
			registerCleanup(() => {
				if (spinnerStatesByToolCallId.get(toolCallId || "") === spinnerState) {
					stopSpinner(toolCallId, spinnerState);
				}
			});
		}
	}

	const spinnerFrame = spinnerState ? BASH_SPINNER_FRAMES[spinnerState.frameIndex] : undefined;
	const elapsedMs = spinnerState?.startedAt !== undefined
		? Date.now() - spinnerState.startedAt
		: undefined;
	updateBashCallComponent(
		component,
		args,
		theme,
		context,
		spinnerFrame,
		elapsedMs,
		toolIntentConfig,
		toolCallStyle,
		commandPreviewRows,
	);
	return component;
}
