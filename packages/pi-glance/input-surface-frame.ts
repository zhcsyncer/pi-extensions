import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { bottomBorderProgressPercent, bottomDetailsBudget, renderBottomDetails } from "./bottom-details.js";
import { inputStashMark, resolveInputStashChrome } from "./input-stash-chrome.js";
import { contextRiskLevel } from "./context-risk.js";
import { renderGlanceLineWithWorktree } from "./status-line.js";
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
import type { GlanceConfig, GlanceState, WorktreeRange, WorktreeText } from "./types.js";
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
	render?: (budget: number, styles: ResolvedGlanceStyles, borderSummaryVisible: boolean, worktreeMarker: string) => string | WorktreeText;
}

export interface InputSurfaceFrameInput {
	state: GlanceState;
	config: GlanceConfig;
	width: number;
	styles: ResolvedGlanceStyles;
	body: InputSurfaceFrameBody;
	chrome?: InputSurfaceFrameChrome;
	status?: InputSurfaceFrameStatus;
	interactiveWorktree?: boolean;
}

export interface WorktreeRegion extends WorktreeRange {
	row: number;
}

export interface InputSurfaceFrameResult {
	lines: string[];
	worktreeRegion?: WorktreeRegion;
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

const WORKTREE_REVIEW_MARKER = " ›";

function canReviewWorktree(input: InputSurfaceFrameInput): boolean {
	return input.interactiveWorktree === true && input.body.kind === "editor" && input.config.enabled
		&& input.config.segments.some((segment) => segment.id === "git" && segment.enabled)
		&& input.state.git.repo && (input.state.git.status === "dirty" || input.state.git.status === "conflict");
}

function resolveStatus(input: InputSurfaceFrameInput, budget: number, borderSummaryVisible: boolean): WorktreeText {
	const marker = canReviewWorktree(input) ? WORKTREE_REVIEW_MARKER : "";
	const rendered = input.status?.render
		? input.status.render(budget, input.styles, borderSummaryVisible, marker)
		: renderGlanceLineWithWorktree(input.state, input.config, budget, input.state.providers.availableCount, { styles: input.styles }, borderSummaryVisible, marker);
	const status = typeof rendered === "string" ? { text: rendered } : rendered;
	if (!status.text || !shouldDimChrome(input)) return status;
	const plain = stripControlsPreservingSpaces(status.text);
	if (marker && status.worktreeRange) {
		const end = status.worktreeRange.end;
		const markerWidth = visibleWidth(marker);
		// Split plain columns after dimming away existing ANSI; keep only the affordance emphasized.
		return {
			...status,
			text: input.styles.dim(sliceByColumn(plain, 0, end - markerWidth, true))
				+ input.styles.strongTitle(sliceByColumn(plain, end - markerWidth, markerWidth, true))
				+ input.styles.dim(sliceByColumn(plain, end, visibleWidth(plain) - end, true)),
		};
	}
	return { ...status, text: input.styles.dim(plain) };
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

	const prefix = modeLabel ? `─ ${modeLabel}${stash ? " · " : " "}` : stash ? "─ " : "";
	const suffix = scrollIndicator ?? (prefix || stash ? "─" : "");
	const budget = Math.max(1, metrics.innerWidth);
	const mark = stash ? truncateToWidth(stash, Math.max(0, budget - visibleWidth(prefix) - visibleWidth(suffix)), "") : "";
	const remainder = truncateToWidth(suffix, Math.max(0, budget - visibleWidth(prefix) - visibleWidth(mark)), "");
	const chunks = [
		{ role: "border" as const, text: prefix },
		...(mark ? [{ role: "status" as const, text: mark }] : []),
		{ role: "border" as const, text: remainder },
	].filter((part) => part.text);
	return { chunks, width: visibleWidth(`${prefix}${mark}${remainder}`) };
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

function renderTopFrame(input: InputSurfaceFrameInput, metrics: Pick<InputSurfaceFrameMetrics, "safeWidth" | "innerWidth">, borderSummaryVisible: boolean): WorktreeText {
	const dimChrome = shouldDimChrome(input);
	const border = activeBorder(input);
	const title = dimChrome ? input.styles.dim : input.styles.title;
	const interactiveLeft = interactiveTopLeftPlan(input, metrics);
	let plan: ReturnType<typeof planSurfaceTopFrame>;
	let status: WorktreeText;

	if (interactiveLeft) {
		const statusBudget = planSurfaceStatusBudget(metrics.innerWidth, interactiveLeft.width);
		status = resolveStatus(input, statusBudget, borderSummaryVisible);
		plan = planSurfaceTopFrame({ width: metrics.safeWidth, left: interactiveLeft, status: status.text });
	} else {
		const statusBudget = planSurfaceStatusFirstBudget(metrics.innerWidth);
		status = resolveStatus(input, statusBudget, borderSummaryVisible);
		const titleMaxWidth = planSurfaceRemainingLeftWidth(metrics.innerWidth, status.text);
		const left = workspaceTitlePlan(input, metrics, titleMaxWidth);
		plan = planSurfaceTopFrame({ width: metrics.safeWidth, left, status: status.text });
	}

	const rendered = renderSurfaceChunks(plan.chunks, {
		border,
		title,
		status: interactiveLeft && input.chrome?.stashOccupied ? (dimChrome ? input.styles.dim : input.styles.warn) : identity,
		text: identity,
		dim: border,
	});
	return {
		text: truncateToWidth(rendered, metrics.safeWidth, border("…")),
		worktreeRange: status.worktreeRange && plan.status.text === status.text ? rangeInStatusChunks(plan.chunks, status.worktreeRange) : undefined,
	};
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

function renderBottomFrame(input: InputSurfaceFrameInput, width: number): WorktreeText {
	const dimmed = shouldDimChrome(input);
	const border = activeBorder(input);
	const innerWidth = surfaceMetrics(width).innerWidth;
	const scrollIndicator = input.chrome?.bottomScrollIndicator;
	const indicatorWidth = Math.min(innerWidth, visibleWidth(scrollIndicator ?? ""));
	const availableDetailsBudget = planSurfaceStatusBudget(innerWidth, indicatorWidth);
	const hasBorderSummary = input.config.enabled && input.config.segments.some((segment) => segment.id === "git" && segment.enabled)
		&& isBorderWorktreeSummary(input.config.git.worktreeSummary) && input.state.git.repo;
	const marker = canReviewWorktree(input) ? WORKTREE_REVIEW_MARKER : "";
	const rawSummary = hasBorderSummary
		? renderWorktreeInline(input.state.git, Math.max(0, availableDetailsBudget - visibleWidth(marker)), input.styles)
		: "";
	const summary = rawSummary
		? (dimmed ? input.styles.dim(stripControlsPreservingSpaces(rawSummary)) : rawSummary) + (marker ? input.styles.strongTitle(marker) : "")
		: "";
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
	const plan = planSurfaceBottomFrame({ width, scrollIndicator, leftStatus, status, contextProgress });
	const text = renderSurfaceChunks(
		plan.chunks,
		{
			border,
			status: identity,
			contextProgressFilled: progressFilled,
			contextProgressEmpty: progressEmpty,
		},
	);
	const summaryStart = detailsStatus ? visibleWidth(detailsStatus) + visibleWidth(joinedSeparator) : 0;
	return {
		text,
		worktreeRange: summary && (input.state.git.status === "dirty" || input.state.git.status === "conflict") && plan.status.text === status
			? rangeInStatusChunks(plan.chunks, { start: summaryStart, end: summaryStart + visibleWidth(summary) }) : undefined,
	};
}

function rangeInStatusChunks(chunks: readonly { role: string; text: string }[], range: WorktreeRange): WorktreeRange | undefined {
	let column = 0;
	let result: WorktreeRange | undefined;
	for (const chunk of chunks) {
		if (chunk.role === "status") result = { start: column + range.start, end: column + range.end };
		column += visibleWidth(chunk.text);
	}
	return result;
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

export function renderInputSurfaceFrameWithWorktree(input: InputSurfaceFrameInput): InputSurfaceFrameResult {
	const metrics = measureInputSurfaceFrame(input.width);
	const sourceLines = bodyLines(input.body);
	const rows = Math.max(minContentRows(input.config), sourceLines.length);
	const bottom = renderBottomFrame(input, metrics.safeWidth);
	const top = renderTopFrame(input, metrics, Boolean(bottom.worktreeRange));
	const margin = renderSurfaceTopMargin(metrics.safeWidth, input.config.editor.topMarginRows);
	const lines = [...margin, top.text];

	for (let i = 0; i < rows; i++) {
		lines.push(renderBodyRow(input, sourceLines[i] ?? "", i, metrics.safeWidth));
	}

	lines.push(bottom.text);
	const range = top.worktreeRange ?? bottom.worktreeRange;
	const worktreeRegion = canReviewWorktree(input) && range
		? { ...range, row: top.worktreeRange ? margin.length : lines.length - 1 } : undefined;
	return { lines, worktreeRegion };
}

export function renderInputSurfaceFrame(input: InputSurfaceFrameInput): string[] {
	return renderInputSurfaceFrameWithWorktree(input).lines;
}
