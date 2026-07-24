import { TOKENS_CACHE_MODE_VALUES, TOKENS_DISPLAY_MODE_VALUES } from "./config-options.js";
import { formatTokens } from "./segment-display-primitives.js";
import type { SegmentFeature } from "./segment-feature.js";
import type { GlanceConfig, SegmentData, SegmentRenderContext } from "./types.js";

const TOKENS_DISPLAY_LABELS: Record<GlanceConfig["tokens"]["display"], string> = {
	"input-output": "input / output",
	total: "total",
};

function nextIn<T extends string | number>(current: T, values: readonly T[]): T {
	const index = values.indexOf(current);
	return values[(index + 1) % values.length] ?? values[0]!;
}

function tokensDisplayLabel(mode: GlanceConfig["tokens"]["display"]): string {
	return TOKENS_DISPLAY_LABELS[mode];
}

function shouldShowTokenCache(ctx: SegmentRenderContext): boolean {
	if (ctx.config.tokens.cache === "hide") return false;
	if (ctx.config.tokens.cache === "show") return true;
	return ctx.widthMode === "full";
}

function tokenCacheParts(ctx: SegmentRenderContext): string[] {
	if (!shouldShowTokenCache(ctx)) return [];
	const usage = ctx.state.usage;
	const parts: string[] = [];
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	return parts;
}

function tokenPrimary(ctx: SegmentRenderContext): string {
	const usage = ctx.state.usage;
	if (ctx.config.tokens.display === "total") return `total ${formatTokens(usage.input + usage.output)}`;
	return `↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}`;
}

function collectTokens(ctx: SegmentRenderContext): SegmentData | undefined {
	const primary = tokenPrimary(ctx);
	const cacheParts = tokenCacheParts(ctx);
	return {
		primary,
		secondary: cacheParts.join(" ") || undefined,
		display: {
			full: [primary, ...cacheParts].join(" "),
			compact: [primary, ...cacheParts].join(" "),
			minimal: [primary, ...cacheParts].join(" "),
		},
	};
}

export const tokensSegmentFeature = {
	id: "tokens",
	label: "Tokens",
	defaultEnabled: false,
	settings: [
		{
			id: "tokens.display",
			label: "Display",
			hint: "Choose input/output or total.",
			kind: "cycle",
			value: (config: GlanceConfig) => tokensDisplayLabel(config.tokens.display),
			mutate: (config: GlanceConfig) => {
				config.tokens.display = nextIn(config.tokens.display, TOKENS_DISPLAY_MODE_VALUES);
			},
		},
		{
			id: "tokens.cache",
			label: "Cache",
			hint: "Show or hide cache details.",
			kind: "cycle",
			value: (config: GlanceConfig) => config.tokens.cache,
			mutate: (config: GlanceConfig) => {
				config.tokens.cache = nextIn(config.tokens.cache, TOKENS_CACHE_MODE_VALUES);
			},
		},
	],
	collect: collectTokens,
} as const satisfies SegmentFeature;
