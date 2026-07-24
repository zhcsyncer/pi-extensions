import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BOTTOM_DETAIL_ICONS } from "./palette.js";
import { formatPercent } from "./segment-display-primitives.js";
import type { ResolvedGlanceStyles, TextStyler } from "./theme-adapter.js";
import type { GlanceConfig, GlanceState } from "./types.js";

const SEPARATOR = " · ";
const MIN_PROGRESS_WIDTH = 3;
const TRACK_START = "╶";
const TRACK_CELL = "─";
const TRACK_END = "╴";
export const BOTTOM_DETAILS_INNER_WIDTH_RATIO = 1 / 3;

export interface BottomDetailsRenderOptions {
	styles?: ResolvedGlanceStyles;
	dimmed?: boolean;
}

interface DetailStylers {
	text: TextStyler;
	muted: TextStyler;
	context: TextStyler;
	autoCompact: TextStyler;
}

function identity(text: string): string {
	return text;
}

function detailStylers(options: BottomDetailsRenderOptions): DetailStylers {
	const styles = options.styles;
	if (!styles) return { text: identity, muted: identity, context: identity, autoCompact: identity };
	if (options.dimmed) return { text: styles.dim, muted: styles.dim, context: styles.dim, autoCompact: styles.dim };
	return {
		text: styles.text,
		muted: styles.dim,
		context: styles.segments.context.fg,
		autoCompact: styles.success,
	};
}

function contextSegmentEnabled(config: GlanceConfig): boolean {
	return config.segments.some((segment) => segment.id === "context" && segment.enabled);
}

function shouldRenderContext(state: GlanceState, config: GlanceConfig): boolean {
	if (config.context.display !== "progress" || !contextSegmentEnabled(config)) return false;
	const unknown = state.context.percent === null && state.context.tokens === null;
	return config.context.unknown === "show" || !unknown;
}

function contextFillCells(percent: number | null, width: number): number {
	if (percent === null || !Number.isFinite(percent)) return 0;
	const clamped = Math.max(0, Math.min(100, percent));
	return Math.round((clamped / 100) * width);
}

function renderContextProgress(
	state: GlanceState,
	config: GlanceConfig,
	width: number,
	stylers: DetailStylers,
): string {
	if (width <= 0 || !shouldRenderContext(state, config)) return "";
	const percent = formatPercent(state.context.percent);
	const suffixWidth = visibleWidth(` ${percent}`);
	const trackWidth = Math.floor(width - suffixWidth);

	if (trackWidth >= MIN_PROGRESS_WIDTH) {
		const track = `${TRACK_START}${TRACK_CELL.repeat(trackWidth - 2)}${TRACK_END}`;
		const filledWidth = contextFillCells(state.context.percent, trackWidth);
		const filled = track.slice(0, filledWidth);
		const empty = track.slice(filledWidth);
		return `${stylers.context(filled)}${stylers.muted(empty)} ${stylers.text(percent)}`;
	}

	return visibleWidth(percent) <= width ? stylers.text(percent) : "";
}

function renderAutoCompact(state: GlanceState, config: GlanceConfig, stylers: DetailStylers): string {
	if (!config.bottomDetails.showAutoCompact || !state.runtime.autoCompactEnabled) return "";
	return stylers.autoCompact(BOTTOM_DETAIL_ICONS[config.icons].autoCompact);
}

export function bottomDetailsBudget(innerWidth: number): number {
	if (!Number.isFinite(innerWidth)) return 0;
	return Math.max(0, Math.floor(innerWidth * BOTTOM_DETAILS_INNER_WIDTH_RATIO));
}

export function renderBottomDetails(
	state: GlanceState,
	config: GlanceConfig,
	width: number,
	options: BottomDetailsRenderOptions = {},
): string {
	if (width <= 0) return "";
	const stylers = detailStylers(options);
	let autoCompact = renderAutoCompact(state, config, stylers);
	const autoCompactWidth = visibleWidth(autoCompact);
	const contextBudget = Math.max(0, width - (autoCompact ? autoCompactWidth + visibleWidth(SEPARATOR) : 0));
	let context = renderContextProgress(state, config, contextBudget, stylers);

	// Context progress is the primary bottom-right fact. On very narrow surfaces,
	// drop the auto-compaction marker before degrading the progress indicator.
	if (!context && shouldRenderContext(state, config) && autoCompact) {
		autoCompact = "";
		context = renderContextProgress(state, config, width, stylers);
	}

	const separator = stylers.muted(SEPARATOR);
	const text = [context, autoCompact].filter(Boolean).join(separator);
	return truncateToWidth(text, width, "");
}
