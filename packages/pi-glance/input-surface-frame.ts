import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { bottomBorderProgressPercent, bottomDetailsBudget, renderBottomDetails } from "./bottom-details.js";
import { inputStashMark, resolveInputStashChrome } from "./input-stash-chrome.js";
import { contextRiskLevel } from "./context-risk.js";
import { renderGlanceLine } from "./status-line.js";
import {
	planSurfaceBottomFrame,
	planSurfaceRemainingLeftWidth,
	planSurfaceRow,
	planSurfaceStatusBudget,
	planSurfaceStatusFirstBudget,
	planSurfaceTopFrame,
	planWorkspaceTitle,
	renderSurfaceChunks,
	renderSurfaceTopMargin,
	surfaceMetrics,
	SURFACE_AUTOCOMPLETE_INDENT,
	SURFACE_CONTENT_PADDING_X,
} from "./surface-layout.js";
import type { ResolvedGlanceStyles, TextStyler } from "./theme-adapter.js";
import type { GlanceConfig, GlanceState } from "./types.js";
import { isBorderWorktreeSummary, renderWorktreeInline } from "./worktree-summary.js";

export type InputSurfaceChromeFocus = "focused" | "unfocused";

export interface InputSurfaceFrameMetrics {
	safeWidth: number;
	innerWidth: number;
	editorContentWidth: number;
	autocompleteIndent: number;
}

export type InputSurfaceFrameBody =
	| { kind: "preview"; lines?: readonly string[]; showPromptIndicator?: boolean }
	| { kind: "editor"; lines: readonly string[] };

export interface InputSurfaceFrameChrome {
	focus?: InputSurfaceChromeFocus;
	showTitle?: boolean;
	border?: TextStyler;
	modeLabel?: string;
	stashOccupied?: boolean;
	topScrollIndicator?: string;
	bottomScrollIndicator?: string;
}

export interface InputSurfaceFrameStatus {
	render?: (budget: number, styles: ResolvedGlanceStyles) => string;
}

export interface InputSurfaceFrameInput {
	state: GlanceState;
	config: GlanceConfig;
	width: number;
	styles: ResolvedGlanceStyles;
	body: InputSurfaceFrameBody;
	chrome?: InputSurfaceFrameChrome;
	status?: InputSurfaceFrameStatus;
}

function identity(text: string): string {
	return text;
}

function stripControlsPreservingSpaces(text: string): string {
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\r\n\t]/g, " ");
}

function minContentRows(config: GlanceConfig): number {
	return Math.max(2, Math.min(4, config.editor.minContentRows));
}

function shouldDimChrome(input: InputSurfaceFrameInput): boolean {
	return input.body.kind === "editor" && input.chrome?.focus === "unfocused";
}

function resolveStatus(input: InputSurfaceFrameInput, budget: number): string {
	const status = input.status?.render
		? input.status.render(budget, input.styles)
		: renderGlanceLine(input.state, input.config, budget, input.state.providers.availableCount, { styles: input.styles });
	if (!status || !shouldDimChrome(input)) return status;
	return input.styles.dim(stripControlsPreservingSpaces(status));
}

function activeBorder(input: InputSurfaceFrameInput): TextStyler {
	return shouldDimChrome(input) ? input.styles.dim : input.chrome?.border ?? input.styles.border;
}

function interactiveTopLeftPlan(input: InputSurfaceFrameInput, metrics: Pick<InputSurfaceFrameMetrics, "innerWidth">) {
	const scrollIndicator = input.chrome?.topScrollIndicator;
	const modeLabel = input.chrome?.modeLabel?.trim();
	const stash = inputStashMark(
		resolveInputStashChrome({
			occupied: input.chrome?.stashOccupied === true,
			hasModeLabel: Boolean(modeLabel),
			hasScrollIndicator: Boolean(scrollIndicator),
		}),
	);
	if (!scrollIndicator && !modeLabel && !stash) return undefined;

	const prefix = modeLabel && stash ? `─ ${modeLabel} · ${stash}` : modeLabel ? `─ ${modeLabel}` : stash ? `─ ${stash}` : "";
	const gap = prefix ? " " : "";
	const text = truncateToWidth(`${prefix}${gap}${scrollIndicator ?? (prefix ? "─" : "")}`, Math.max(1, metrics.innerWidth), "");
	const chunks = [{ role: "border" as const, text }];
	return { chunks, width: visibleWidth(text) };
}

function workspaceTitlePlan(
	input: InputSurfaceFrameInput,
	metrics: Pick<InputSurfaceFrameMetrics, "safeWidth" | "innerWidth">,
	maxWidth?: number,
) {
	return planWorkspaceTitle({
		workspacePath: input.state.workspace.path,
		workspaceName: input.state.workspace.name,
		mode: input.config.display.workspaceLabel,
		innerWidth: metrics.innerWidth,
		surfaceWidth: metrics.safeWidth,
		showTitle: input.chrome?.showTitle,
		maxWidth,
	});
}

function renderTopFrame(input: InputSurfaceFrameInput, metrics: Pick<InputSurfaceFrameMetrics, "safeWidth" | "innerWidth">): string {
	const dimChrome = shouldDimChrome(input);
	const border = activeBorder(input);
	const title = dimChrome ? input.styles.dim : input.styles.title;
	const interactiveLeft = interactiveTopLeftPlan(input, metrics);
	let plan: ReturnType<typeof planSurfaceTopFrame>;

	if (interactiveLeft) {
		const statusBudget = planSurfaceStatusBudget(metrics.innerWidth, interactiveLeft.width);
		const status = resolveStatus(input, statusBudget);
		plan = planSurfaceTopFrame({ width: metrics.safeWidth, left: interactiveLeft, status });
	} else {
		const statusBudget = planSurfaceStatusFirstBudget(metrics.innerWidth);
		const status = resolveStatus(input, statusBudget);
		const titleMaxWidth = planSurfaceRemainingLeftWidth(metrics.innerWidth, status);
		const left = workspaceTitlePlan(input, metrics, titleMaxWidth);
		plan = planSurfaceTopFrame({ width: metrics.safeWidth, left, status });
	}

	const rendered = renderSurfaceChunks(plan.chunks, {
		border,
		title,
		status: identity,
		text: identity,
		dim: border,
	});
	return truncateToWidth(rendered, metrics.safeWidth, border("…"));
}

function renderPreviewRow(input: InputSurfaceFrameInput, text: string, index: number, width: number): string {
	const showPromptIndicator = input.body.kind === "preview" && input.body.showPromptIndicator === true && index === 0;
	return renderSurfaceChunks(
		planSurfaceRow({
			width,
			text,
			prefix: showPromptIndicator ? "› " : "  ",
			ellipsis: input.styles.dim("…"),
			prefixRole: showPromptIndicator ? "dim" : "text",
		}).chunks,
		{
			border: input.styles.border,
			content: input.styles.text,
			dim: input.styles.dim,
			text: identity,
		},
	);
}

function renderEditorRow(input: InputSurfaceFrameInput, text: string, width: number): string {
	const border = activeBorder(input);
	return renderSurfaceChunks(
		planSurfaceRow({
			width,
			text,
			paddingX: SURFACE_CONTENT_PADDING_X,
			reserveRightPadding: true,
			ellipsis: "",
		}).chunks,
		{
			border,
			content: identity,
			text: identity,
		},
	);
}

function bodyLines(body: InputSurfaceFrameBody): readonly string[] {
	if (body.kind === "preview") return body.lines ?? [""];
	return body.lines;
}

function renderBodyRow(input: InputSurfaceFrameInput, text: string, index: number, width: number): string {
	return input.body.kind === "preview"
		? renderPreviewRow(input, text, index, width)
		: renderEditorRow(input, text, width);
}

function renderBottomFrame(input: InputSurfaceFrameInput, width: number): string {
	const dimmed = shouldDimChrome(input);
	const border = activeBorder(input);
	const innerWidth = surfaceMetrics(width).innerWidth;
	const scrollIndicator = input.chrome?.bottomScrollIndicator;
	const indicatorWidth = Math.min(innerWidth, visibleWidth(scrollIndicator ?? ""));
	const availableDetailsBudget = planSurfaceStatusBudget(innerWidth, indicatorWidth);
	const hasBorderSummary = isBorderWorktreeSummary(input.config.git.worktreeSummary) && input.state.git.repo;
	const rawSummary = hasBorderSummary
		? renderWorktreeInline(input.state.git, availableDetailsBudget, input.styles)
		: "";
	const summary = dimmed && rawSummary
		? input.styles.dim(stripControlsPreservingSpaces(rawSummary))
		: rawSummary;
	const summaryReservation = summary ? visibleWidth(summary) + visibleWidth(" · ") : 0;
	const remainingDetailsBudget = Math.max(0, availableDetailsBudget - summaryReservation);
	const detailsBudget = input.config.context.progressWidth === "remaining"
		? remainingDetailsBudget
		: Math.min(remainingDetailsBudget, bottomDetailsBudget(innerWidth));
	const detailsStatus = renderBottomDetails(input.state, input.config, detailsBudget, { styles: input.styles, dimmed });
	const joinedSeparator = input.styles.separator(" · ");
	const leftStatus = "";
	const status = summary
		? [detailsStatus, summary].filter(Boolean).join(joinedSeparator)
		: detailsStatus;
	const progressPercent = bottomBorderProgressPercent(input.state, input.config);
	const contextProgress = progressPercent === undefined
		? undefined
		: {
				percent: progressPercent,
				maxWidth: input.config.context.progressWidth === "third"
					? Math.max(0, detailsBudget - visibleWidth(detailsStatus))
					: undefined,
			};
	const risk = contextRiskLevel(progressPercent);
	const progressFilled = dimmed
		? input.styles.dim
		: risk === "error"
			? input.styles.error
			: risk === "warning"
				? input.styles.warn
				: risk === "unknown"
					? input.styles.dim
					: input.styles.segments.context.fg;
	const progressEmpty = dimmed || risk === "unknown" ? input.styles.dim : border;
	return renderSurfaceChunks(
		planSurfaceBottomFrame({ width, scrollIndicator, leftStatus, status, contextProgress }).chunks,
		{
			border,
			status: identity,
			contextProgressFilled: progressFilled,
			contextProgressEmpty: progressEmpty,
		},
	);
}

export function measureInputSurfaceFrame(width: number): InputSurfaceFrameMetrics {
	const { safeWidth, innerWidth } = surfaceMetrics(width);
	return {
		safeWidth,
		innerWidth,
		editorContentWidth: Math.max(1, safeWidth - 2 - SURFACE_CONTENT_PADDING_X * 2),
		autocompleteIndent: Math.min(SURFACE_AUTOCOMPLETE_INDENT, Math.max(0, safeWidth - 1)),
	};
}

export function renderInputSurfaceFrame(input: InputSurfaceFrameInput): string[] {
	const metrics = measureInputSurfaceFrame(input.width);
	const sourceLines = bodyLines(input.body);
	const rows = Math.max(minContentRows(input.config), sourceLines.length);
	const lines = [
		...renderSurfaceTopMargin(metrics.safeWidth, input.config.editor.topMarginRows),
		renderTopFrame(input, metrics),
	];

	for (let i = 0; i < rows; i++) {
		lines.push(renderBodyRow(input, sourceLines[i] ?? "", i, metrics.safeWidth));
	}

	lines.push(renderBottomFrame(input, metrics.safeWidth));
	return lines;
}
