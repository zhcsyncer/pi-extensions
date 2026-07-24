import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { bottomDetailsBudget, renderBottomDetails } from "./bottom-details.js";
import { renderGlanceLine } from "./status-line.js";
import {
	planSurfaceBottomFrame,
	planSurfaceRow,
	planSurfaceStatusBudget,
	planSurfaceTopFrame,
	planWorkspaceTitle,
	renderSurfaceChunks,
	renderSurfaceTopMargin,
	surfaceMetrics,
	SURFACE_AUTOCOMPLETE_INDENT,
	SURFACE_CONTENT_PADDING_X,
} from "./surface-layout.js";
import type { ResolvedGlanceStyles } from "./theme-adapter.js";
import type { GlanceConfig, GlanceState } from "./types.js";

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

function topLeftPlan(input: InputSurfaceFrameInput, metrics: Pick<InputSurfaceFrameMetrics, "safeWidth" | "innerWidth">) {
	const scrollIndicator = input.chrome?.topScrollIndicator;
	if (scrollIndicator) {
		const chunks = [{ role: "border" as const, text: scrollIndicator }];
		return { chunks, width: visibleWidth(scrollIndicator) };
	}

	return planWorkspaceTitle({
		workspacePath: input.state.workspace.path,
		workspaceName: input.state.workspace.name,
		mode: input.config.display.workspaceLabel,
		innerWidth: metrics.innerWidth,
		surfaceWidth: metrics.safeWidth,
		showTitle: input.chrome?.showTitle,
	});
}

function renderTopFrame(input: InputSurfaceFrameInput, metrics: Pick<InputSurfaceFrameMetrics, "safeWidth" | "innerWidth">): string {
	const dimChrome = shouldDimChrome(input);
	const border = dimChrome ? input.styles.dim : input.styles.border;
	const title = dimChrome ? input.styles.dim : input.styles.title;
	const left = topLeftPlan(input, metrics);
	const statusBudget = planSurfaceStatusBudget(metrics.innerWidth, left.width);
	const status = resolveStatus(input, statusBudget);
	const rendered = renderSurfaceChunks(planSurfaceTopFrame({ width: metrics.safeWidth, left, status }).chunks, {
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
	const border = shouldDimChrome(input) ? input.styles.dim : input.styles.border;
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
	const border = dimmed ? input.styles.dim : input.styles.border;
	const detailsBudget = bottomDetailsBudget(surfaceMetrics(width).innerWidth);
	const status = renderBottomDetails(input.state, input.config, detailsBudget, { styles: input.styles, dimmed });
	return renderSurfaceChunks(
		planSurfaceBottomFrame({ width, scrollIndicator: input.chrome?.bottomScrollIndicator, status }).chunks,
		{
			border,
			status: identity,
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
