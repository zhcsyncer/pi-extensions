import { formatCost } from "./segment-display-primitives.js";
import type { SegmentFeature } from "./segment-feature.js";
import type { GlanceConfig, SegmentData, SegmentRenderContext } from "./types.js";

function onOff(value: boolean): string {
	return value ? "on" : "off";
}

function collectCost(ctx: SegmentRenderContext): SegmentData | undefined {
	if (ctx.config.cost.hideZero && !ctx.state.usage.costUnknown && (!Number.isFinite(ctx.state.usage.cost) || ctx.state.usage.cost <= 0)) return undefined;
	return {
		primary: `${formatCost(ctx.state.usage.cost)}${ctx.state.usage.costUnknown ? "?" : ""}`,
	};
}

export const costSegmentFeature = {
	id: "cost",
	label: "Cost",
	defaultEnabled: true,
	settings: [
		{
			id: "cost.hideZero",
			label: "Hide zero",
			hint: "Hide until cost is non-zero.",
			kind: "toggle",
			value: (config: GlanceConfig) => onOff(config.cost.hideZero),
			mutate: (config: GlanceConfig) => {
				config.cost.hideZero = !config.cost.hideZero;
			},
		},
	],
	collect: collectCost,
} as const satisfies SegmentFeature;
