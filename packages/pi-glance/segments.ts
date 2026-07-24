import type { SegmentData, SegmentDefinition, SegmentRenderContext, SegmentRenderResult } from "./types.js";

function displayForMode(data: SegmentData, widthMode: SegmentRenderContext["widthMode"]): string {
	if (widthMode === "minimal" && data.display?.minimal !== undefined) return data.display.minimal;
	if (widthMode === "compact" && data.display?.compact !== undefined) return data.display.compact;
	if (widthMode === "full" && data.display?.full !== undefined) return data.display.full;
	const secondary = data.secondary ? ` ${data.secondary}` : "";
	return `${data.primary}${secondary}`.trim();
}

function iconGapForSegment(ctx: SegmentRenderContext, segment: SegmentDefinition): string {
	return segment.id === "throughput" && ctx.config.icons === "nerd" ? "  " : " ";
}

function renderCollectedSegment(ctx: SegmentRenderContext, segment: SegmentDefinition, data: SegmentData): SegmentRenderResult {
	const icon = ctx.icons[segment.id];
	const value = displayForMode(data, ctx.widthMode);
	const prefix = icon ? `${icon}${iconGapForSegment(ctx, segment)}` : "";
	return {
		id: segment.id,
		text: `${prefix}${value}`.trim(),
	};
}

export function renderSegment(ctx: SegmentRenderContext, segment: SegmentDefinition): SegmentRenderResult | undefined {
	const data = segment.collect(ctx);
	return data ? renderCollectedSegment(ctx, segment, data) : undefined;
}
