import type { GlanceConfig, SegmentDefinition } from "./types.js";

type EditableSegmentSettingKind = "toggle" | "cycle";

interface SegmentSettingDescriptorBase {
	id: string;
	label: string;
	hint: string;
	value(config: GlanceConfig): string;
}

export type EditableSegmentSettingDescriptor = SegmentSettingDescriptorBase & {
	kind: EditableSegmentSettingKind;
	mutate(config: GlanceConfig): void;
};

export type InfoSegmentSettingDescriptor = SegmentSettingDescriptorBase & {
	kind: "info";
};

export type SegmentSettingDescriptor = EditableSegmentSettingDescriptor | InfoSegmentSettingDescriptor;

export type SegmentFeature = SegmentDefinition & {
	defaultEnabled: boolean;
	settings: readonly SegmentSettingDescriptor[];
};
