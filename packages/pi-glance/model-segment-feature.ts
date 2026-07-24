import { MODEL_THINKING_MODE_VALUES, PROVIDER_DISPLAY_MODE_VALUES } from "./config-options.js";
import type { SegmentFeature } from "./segment-feature.js";
import type { GlanceConfig, SegmentData, SegmentRenderContext } from "./types.js";

function nextIn<T extends string | number>(current: T, values: readonly T[]): T {
	const index = values.indexOf(current);
	return values[index + 1] ?? values[0]!;
}

function shouldShowThinking(ctx: SegmentRenderContext, thinking: string): boolean {
	if (ctx.config.model.showThinking === "never") return false;
	if (ctx.config.model.showThinking === "always") return Boolean(thinking);
	return thinking !== "off" && ctx.widthMode !== "minimal";
}

function collectModel(ctx: SegmentRenderContext): SegmentData | undefined {
	let model = ctx.state.model.displayName || ctx.state.model.id || "no-model";
	if (ctx.showProvider && ctx.state.model.provider) {
		model = `${ctx.state.model.provider}/${model}`;
	}
	const thinking = ctx.state.model.thinking || "off";
	const visibleThinking = shouldShowThinking(ctx, thinking) ? thinking : "";
	return {
		primary: model,
		secondary: visibleThinking || undefined,
		display: {
			full: visibleThinking ? `${model} ${visibleThinking}` : model,
			compact: visibleThinking ? `${model} ${visibleThinking}` : model,
			minimal: visibleThinking ? `${model} ${visibleThinking}` : model,
		},
	};
}

export const modelSegmentFeature = {
	id: "model",
	label: "Model",
	defaultEnabled: true,
	settings: [
		{
			id: "model.providerLabel",
			label: "Provider label",
			hint: "Show provider name.",
			kind: "cycle",
			value: (config: GlanceConfig) => config.display.showProvider,
			mutate: (config: GlanceConfig) => {
				config.display.showProvider = nextIn(config.display.showProvider, PROVIDER_DISPLAY_MODE_VALUES);
			},
		},
		{
			id: "model.thinkingLabel",
			label: "Thinking label",
			hint: "Show thinking level.",
			kind: "cycle",
			value: (config: GlanceConfig) => config.model.showThinking,
			mutate: (config: GlanceConfig) => {
				config.model.showThinking = nextIn(config.model.showThinking, MODEL_THINKING_MODE_VALUES);
			},
		},
	],
	collect: collectModel,
} as const satisfies SegmentFeature;
