import { contextSegmentFeature } from "./context-segment-feature.js";
import { costSegmentFeature } from "./cost-segment-feature.js";
import { gitSegmentFeature } from "./git-segment-feature.js";
import { modelSegmentFeature } from "./model-segment-feature.js";
import { throughputSegmentFeature } from "./throughput-segment-feature.js";
import { tokensSegmentFeature } from "./tokens-segment-feature.js";
import type { SegmentFeature, SegmentSettingDescriptor } from "./segment-feature.js";
import type { SegmentConfig, SegmentId } from "./types.js";

export { type SegmentId } from "./types.js";
export type { EditableSegmentSettingDescriptor, InfoSegmentSettingDescriptor, SegmentSettingDescriptor } from "./segment-feature.js";

export const SEGMENT_IDS = ["git", "cost", "throughput", "context", "tokens", "model"] as const satisfies readonly SegmentId[];

export type SegmentRegistryEntry = SegmentFeature;

export interface SegmentCoverage {
	missing: SegmentId[];
	extra: string[];
}

export const SEGMENT_REGISTRY = [
	gitSegmentFeature,
	costSegmentFeature,
	throughputSegmentFeature,
	contextSegmentFeature,
	tokensSegmentFeature,
	modelSegmentFeature,
] as const satisfies readonly SegmentRegistryEntry[];

export const SEGMENT_BY_ID: ReadonlyMap<SegmentId, SegmentRegistryEntry> = new Map(
	SEGMENT_REGISTRY.map((segment) => [segment.id, segment]),
);

const SEGMENT_ID_SET: ReadonlySet<string> = new Set(SEGMENT_IDS);

export function defaultSegmentConfigs(): SegmentConfig[] {
	return SEGMENT_REGISTRY.map((segment) => ({ id: segment.id, enabled: segment.defaultEnabled }));
}

export function isSegmentId(value: unknown): value is SegmentId {
	return typeof value === "string" && SEGMENT_ID_SET.has(value);
}

export function segmentLabel(id: SegmentId): string {
	return SEGMENT_BY_ID.get(id)?.label ?? id;
}

export function segmentRecordCoverage(record: Record<string, unknown>): SegmentCoverage {
	const keys = Object.keys(record);
	const keySet = new Set(keys);
	return {
		missing: SEGMENT_IDS.filter((id) => !keySet.has(id)),
		extra: keys.filter((key) => !isSegmentId(key)),
	};
}

export function getSegmentSettings(id: SegmentId): readonly SegmentSettingDescriptor[] {
	return SEGMENT_BY_ID.get(id)?.settings ?? [];
}
