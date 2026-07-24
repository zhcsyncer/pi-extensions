import {
	CONTEXT_DISPLAY_MODE_VALUES,
	CONTEXT_PROGRESS_STYLE_VALUES,
	CONTEXT_PROGRESS_WIDTH_VALUES,
	CONTEXT_UNKNOWN_MODE_VALUES,
} from "./config-options.js";
import { formatPercent, formatTokens } from "./segment-display-primitives.js";
import type { SegmentFeature } from "./segment-feature.js";
import type { GlanceConfig, SegmentData, SegmentRenderContext } from "./types.js";

const CONTEXT_DISPLAY_LABELS: Record<GlanceConfig["context"]["display"], string> = {
	"percent+tokens": "percent / tokens",
	percent: "percent",
	tokens: "tokens",
	progress: "progress bar",
};

function nextIn<T extends string | number>(current: T, values: readonly T[]): T {
	const index = values.indexOf(current);
	return values[(index + 1) % values.length] ?? values[0]!;
}

function contextDisplayLabel(mode: GlanceConfig["context"]["display"]): string {
	return CONTEXT_DISPLAY_LABELS[mode];
}

function contextProgressWidthLabel(width: GlanceConfig["context"]["progressWidth"]): string {
	return width === "third" ? "one third" : "remaining";
}

function contextTokenRatio(ctx: SegmentRenderContext): string {
	return `${formatTokens(ctx.state.context.tokens)}/${formatTokens(ctx.state.context.window)}`;
}

function contextIsUnknown(ctx: SegmentRenderContext): boolean {
	return ctx.state.context.percent === null && ctx.state.context.tokens === null;
}

function contextDisplayValue(ctx: SegmentRenderContext): string {
	const pct = formatPercent(ctx.state.context.percent);
	const ratio = contextTokenRatio(ctx);
	if (ctx.config.context.display === "percent") return pct;
	if (ctx.config.context.display === "tokens") return ratio;
	return `${pct} ${ratio}`;
}

function contextCompactValue(ctx: SegmentRenderContext): string {
	if (ctx.config.context.display === "tokens") return contextTokenRatio(ctx);
	return formatPercent(ctx.state.context.percent);
}

function collectContext(ctx: SegmentRenderContext): SegmentData | undefined {
	if (ctx.config.context.display === "progress") return undefined;
	if (ctx.config.context.unknown === "hide" && contextIsUnknown(ctx)) return undefined;
	const primary = ctx.config.context.display === "tokens" ? contextTokenRatio(ctx) : formatPercent(ctx.state.context.percent);
	const secondary = ctx.config.context.display === "percent+tokens" ? contextTokenRatio(ctx) : undefined;
	const compact = contextCompactValue(ctx);
	return {
		primary,
		secondary,
		display: {
			full: contextDisplayValue(ctx),
			compact,
			minimal: compact,
		},
	};
}

export const contextSegmentFeature = {
	id: "context",
	label: "Context",
	defaultEnabled: true,
	settings: [
		{
			id: "context.display",
			label: "Display",
			hint: "Choose text details or a bottom-right progress bar.",
			kind: "cycle",
			value: (config: GlanceConfig) => contextDisplayLabel(config.context.display),
			mutate: (config: GlanceConfig) => {
				config.context.display = nextIn(config.context.display, CONTEXT_DISPLAY_MODE_VALUES);
			},
		},
		{
			id: "context.progressStyle",
			label: "Progress style",
			hint: "Use a standalone track or the input border itself.",
			kind: "cycle",
			value: (config: GlanceConfig) => config.context.progressStyle,
			mutate: (config: GlanceConfig) => {
				config.context.progressStyle = nextIn(config.context.progressStyle, CONTEXT_PROGRESS_STYLE_VALUES);
			},
		},
		{
			id: "context.progressWidth",
			label: "Progress width",
			hint: "Use one third or all remaining bottom-border space.",
			kind: "cycle",
			value: (config: GlanceConfig) => contextProgressWidthLabel(config.context.progressWidth),
			mutate: (config: GlanceConfig) => {
				config.context.progressWidth = nextIn(config.context.progressWidth, CONTEXT_PROGRESS_WIDTH_VALUES);
			},
		},
		{
			id: "context.unknown",
			label: "Unknown",
			hint: "Show ? or hide when context is unknown.",
			kind: "cycle",
			value: (config: GlanceConfig) => config.context.unknown,
			mutate: (config: GlanceConfig) => {
				config.context.unknown = nextIn(config.context.unknown, CONTEXT_UNKNOWN_MODE_VALUES);
			},
		},
	],
	collect: collectContext,
} as const satisfies SegmentFeature;
