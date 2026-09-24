import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { contextRiskLevel } from "./context-risk.js";
import { ICONS } from "./palette.js";
import { SEGMENT_BY_ID } from "./segment-registry.js";
import { renderSegment } from "./segments.js";
import { resolveGlanceRenderStyles, type GlanceRenderStyleContext, type ResolvedGlanceStyles } from "./theme-adapter.js";
import type { GlanceConfig, GlanceState, SegmentRenderContext, SegmentRenderResult, WidthMode, WorktreeText } from "./types.js";

const RESET = "\x1b[0m";

const GIT_BASE_BEHIND_PATTERN = /main↓[0-9]+/;

function applyGitSegmentStyle(styles: ResolvedGlanceStyles, text: string): string {
	const match = text.match(GIT_BASE_BEHIND_PATTERN);
	if (!match || match.index === undefined) return styles.segments.git.fg(text);
	const start = match.index;
	const end = start + match[0].length;
	return `${styles.segments.git.fg(text.slice(0, start))}${styles.gitBase(text.slice(start, end))}${styles.segments.git.fg(text.slice(end))}`;
}

function applyInlineSegmentStyle(segment: SegmentRenderResult, styles: ResolvedGlanceStyles, text: string): string {
	if (segment.id === "context") {
		const match = text.match(/([0-9]+(?:\.[0-9]+)?)%/);
		const risk = contextRiskLevel(match ? Number.parseFloat(match[1]!) : null);
		if (risk === "error") return styles.error(text);
		if (risk === "warning") return styles.warn(text);
		return styles.segments.context.fg(text);
	}
	if (segment.id === "git") return applyGitSegmentStyle(styles, text);
	return styles.segments[segment.id].fg(text);
}

function widthModeFor(width: number): WidthMode {
	if (width < 64) return "minimal";
	if (width < 96) return "compact";
	return "full";
}

function resolveShowProvider(config: GlanceConfig, providerCount: number, widthMode: WidthMode): boolean {
	if (config.display.showProvider === "always") return true;
	if (config.display.showProvider === "never") return false;
	return providerCount > 1 && widthMode === "full";
}

function renderEnabledSegments(
	state: GlanceState,
	config: GlanceConfig,
	width: number,
	providerCount = 1,
	styleContext: GlanceRenderStyleContext = {},
	visibility: Pick<SegmentRenderContext, "borderWorktreeSummaryVisible" | "omitWorktreeSummary"> = {},
): { styles: ResolvedGlanceStyles; segments: SegmentRenderResult[] } {
	const widthMode = widthModeFor(width);
	const styles = resolveGlanceRenderStyles(config, styleContext);
	const icons = ICONS[config.icons];
	const ctx: SegmentRenderContext = {
		state,
		config,
		widthMode,
		icons,
		showProvider: resolveShowProvider(config, providerCount, widthMode),
		...visibility,
	};
	const rendered: SegmentRenderResult[] = [];
	for (const segmentConfig of config.segments) {
		if (!segmentConfig.enabled) continue;
		const definition = SEGMENT_BY_ID.get(segmentConfig.id);
		if (!definition) continue;
		const result = renderSegment(ctx, definition);
		if (result) rendered.push(result);
	}
	return { styles, segments: rendered };
}

interface JoinedSegments extends WorktreeText {
	width: number;
	gitFallback?: SegmentRenderResult["gitFallback"];
}

function joinSegments(styles: ResolvedGlanceStyles, segments: SegmentRenderResult[], worktreeMarker: string): JoinedSegments {
	if (segments.length === 0) return { text: "", width: 0 };
	const text = `${segments
		.map((segment) => applyInlineSegmentStyle(segment, styles, segment.text) + (segment.worktreeRange && worktreeMarker ? styles.strongTitle(worktreeMarker) : ""))
		.join(styles.separator(" · "))}${RESET}`;
	let offset = 0;
	let worktreeRange: WorktreeText["worktreeRange"];
	for (const segment of segments) {
		const markerWidth = segment.worktreeRange ? visibleWidth(worktreeMarker) : 0;
		if (segment.worktreeRange) worktreeRange = { start: offset + segment.worktreeRange.start, end: offset + segment.worktreeRange.end + markerWidth };
		offset += visibleWidth(segment.text) + markerWidth + visibleWidth(" · ");
	}
	return { text, width: visibleWidth(text), worktreeRange, gitFallback: segments.length === 1 ? segments[0]?.gitFallback : undefined };
}

function fitSegments(styles: ResolvedGlanceStyles, segments: SegmentRenderResult[], width: number, worktreeMarker: string): JoinedSegments {
	const fitted = [...segments];
	let joined = joinSegments(styles, fitted, worktreeMarker);
	while (fitted.length > 1 && joined.width > width) {
		fitted.pop();
		joined = joinSegments(styles, fitted, worktreeMarker);
	}
	return joined;
}

export function renderGlanceLineWithWorktree(
	state: GlanceState,
	config: GlanceConfig,
	width: number,
	providerCount = state.providers.availableCount,
	styleContext: GlanceRenderStyleContext = {},
	borderWorktreeSummaryVisible = false,
	worktreeMarker = "",
): WorktreeText {
	if (!config.enabled || width <= 0) return { text: "" };
	const { styles, segments } = renderEnabledSegments(state, config, width, providerCount, styleContext, { borderWorktreeSummaryVisible });
	let line = fitSegments(styles, segments, width, worktreeMarker);
	if (line.worktreeRange && line.width > width) {
		// One-way fallback: a clipped summary is not evidence that changes are visible.
		const fallback = renderEnabledSegments(state, config, width, providerCount, styleContext, { borderWorktreeSummaryVisible, omitWorktreeSummary: true });
		line = fitSegments(styles, fallback.segments, width, worktreeMarker);
	}
	if (line.width > width) {
		if (line.gitFallback) {
			const { label, marker } = line.gitFallback;
			const budget = width - visibleWidth(marker) - 1;
			const text = budget > 0 ? `${truncateToWidth(label, budget, "…")} ${marker}` : truncateToWidth(marker, width, "");
			return { text: applyGitSegmentStyle(styles, text) };
		}
		return { text: truncateToWidth(line.text, width, styles.dim("…")) };
	}
	return { text: line.text, worktreeRange: line.worktreeRange };
}

export function renderGlanceLine(
	state: GlanceState, config: GlanceConfig, width: number,
	providerCount = state.providers.availableCount, styleContext: GlanceRenderStyleContext = {},
): string {
	return renderGlanceLineWithWorktree(state, config, width, providerCount, styleContext).text;
}
