import {
	CONTEXT_PROGRESS_STYLE_VALUES,
	CONTEXT_PROGRESS_WIDTH_VALUES,
	CONTEXT_TEXT_MODE_VALUES,
} from "./config-options.js";
import { formatPercent, formatTokens } from "./segment-display-primitives.js";
import type { SegmentFeature } from "./segment-feature.js";
import type { ContextTextMode, GlanceConfig, SegmentData, SegmentRenderContext } from "./types.js";

const CONTEXT_TEXT_LABELS: Record<ContextTextMode, string> = {
	"percent+tokens": "percent / tokens",
	percent: "percent",
	tokens: "tokens",
};

function nextIn<T extends string | number>(current: T, values: readonly T[]): T {
	const index = values.indexOf(current);
	return values[(index + 1) % values.length] ?? values[0]!;
}

function contextTextLabel(mode: ContextTextMode): string {
	return CONTEXT_TEXT_LABELS[mode];
}

function contextProgressWidthLabel(width: GlanceConfig["context"]["progressWidth"]): string {
	return width === "third" ? "one third" : "remaining";
}

function contextTokenRatio(ctx: SegmentRenderContext): string {
	return `${formatTokens(ctx.state.context.tokens)}/${formatTokens(ctx.state.context.window)}`;
}

function contextDisplayValue(ctx: SegmentRenderContext): string {
	const pct = formatPercent(ctx.state.context.percent);
	const ratio = contextTokenRatio(ctx);
	if (ctx.config.context.text === "percent") return pct;
	if (ctx.config.context.text === "tokens") return ratio;
	return `${pct} ${ratio}`;
}

function contextCompactValue(ctx: SegmentRenderContext): string {
	if (ctx.config.context.text === "tokens") return contextTokenRatio(ctx);
	return formatPercent(ctx.state.context.percent);
}

function collectContext(ctx: SegmentRenderContext): SegmentData | undefined {
	// Progress mode owns the text channel and renders it next to the bottom bar.
	if (ctx.config.context.progress) return undefined;
	const primary = ctx.config.context.text === "tokens" ? contextTokenRatio(ctx) : formatPercent(ctx.state.context.percent);
	const secondary = ctx.config.context.text === "percent+tokens" ? contextTokenRatio(ctx) : undefined;
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
			id: "context.text",
			label: "Text",
			hint: "Text details. With Progress bar on, this label moves to the bottom and always includes percent.",
			kind: "cycle",
			value: (config: GlanceConfig) => contextTextLabel(config.context.text),
			mutate: (config: GlanceConfig) => {
				config.context.text = nextIn(config.context.text, CONTEXT_TEXT_MODE_VALUES);
			},
		},
		{
			id: "context.progress",
			label: "Progress bar",
			hint: "Show a bottom-right bar. Text moves next to it and always includes percent.",
			kind: "toggle",
			value: (config: GlanceConfig) => (config.context.progress ? "on" : "off"),
			mutate: (config: GlanceConfig) => {
				config.context.progress = !config.context.progress;
			},
		},
		{
			id: "context.progressStyle",
			label: "Progress style",
			hint: "Use a standalone track or the input border itself.",
			kind: "cycle",
			visible: (config: GlanceConfig) => config.context.progress,
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
			visible: (config: GlanceConfig) => config.context.progress,
			value: (config: GlanceConfig) => contextProgressWidthLabel(config.context.progressWidth),
			mutate: (config: GlanceConfig) => {
				config.context.progressWidth = nextIn(config.context.progressWidth, CONTEXT_PROGRESS_WIDTH_VALUES);
			},
		},
	],
	collect: collectContext,
} as const satisfies SegmentFeature;
