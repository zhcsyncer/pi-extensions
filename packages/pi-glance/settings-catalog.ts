import { cloneConfig, toggleSegment } from "./config.js";
import {
	EDITOR_TOP_MARGIN_ROW_VALUES,
	ICON_MODE_VALUES,
	WORKSPACE_LABEL_MODE_VALUES,
} from "./config-options.js";
import { getSegmentSettings, segmentLabel, type SegmentSettingDescriptor } from "./segment-registry.js";
import { GLANCE_THEMES, GLANCE_THEME_IDS, themeLabel as glanceThemeLabel } from "./themes.js";
import type { GlanceThemeSlot } from "./theme-selection.js";
import type { EditorTopMarginRows, GlanceConfig, GlanceThemeName, SegmentId } from "./types.js";
export type { GlanceThemeSlot } from "./theme-selection.js";

export type SettingsCategoryId = "general" | "details" | SegmentId;
type SettingsRowKind = "toggle" | "cycle" | "info";
export type SettingsRowSubview = "themeBrowser";

export interface SettingsCategory {
	id: SettingsCategoryId;
	label: string;
	enabled?: boolean;
}

export interface SettingsRow {
	id: string;
	label: string;
	value: string;
	hint: string;
	kind: SettingsRowKind;
	opensSubview?: SettingsRowSubview;
	themeSlot?: GlanceThemeSlot;
	apply?: (config: GlanceConfig) => GlanceConfig;
}

export interface ThemeBrowserCatalogItem {
	id: GlanceThemeName;
	label: string;
	group: string;
	groupLabel: string;
	tone: string;
	tags: readonly string[];
	detailTags: readonly string[];
	description: string;
	detailDescription: string;
}

const MIN_CONTENT_ROWS = [2, 3, 4] as const;

function nextIn<T extends string>(current: T, values: readonly T[]): T {
	const index = values.indexOf(current);
	return values[(index + 1) % values.length] ?? values[0]!;
}

function nextNumber<T extends number>(current: number, values: readonly T[]): T {
	const index = values.indexOf(current as T);
	return values[(index + 1) % values.length] ?? values[0]!;
}

function withConfig(config: GlanceConfig, mutate: (next: GlanceConfig) => void): GlanceConfig {
	const next = cloneConfig(config);
	mutate(next);
	return next;
}

function onOff(value: boolean): string {
	return value ? "on" : "off";
}

function topMarginRowsLabel(value: EditorTopMarginRows): string {
	return value === 0 ? "none" : value === 1 ? "1 row" : "2 rows";
}

function toggleRow(id: string, label: string, value: boolean, hint: string, apply: (config: GlanceConfig) => GlanceConfig): SettingsRow {
	return { id, label, value: onOff(value), hint, kind: "toggle", apply };
}

function cycleRow(
	id: string,
	label: string,
	value: string,
	hint: string,
	apply: (config: GlanceConfig) => GlanceConfig,
	options: Pick<SettingsRow, "opensSubview" | "themeSlot"> = {},
): SettingsRow {
	return { id, label, value, hint, kind: "cycle", ...options, apply };
}

function infoRow(id: string, label: string, value: string, hint: string): SettingsRow {
	return { id, label, value, hint, kind: "info" };
}

export function getThemeCatalog(): readonly ThemeBrowserCatalogItem[] {
	return GLANCE_THEMES;
}

export function getThemeCatalogForSlot(slot: GlanceThemeSlot): readonly ThemeBrowserCatalogItem[] {
	return [
		...GLANCE_THEMES.filter((theme) => theme.tone === slot),
		...GLANCE_THEMES.filter((theme) => theme.tone !== slot),
	];
}

function themeIdsForSlot(slot: GlanceThemeSlot | undefined): readonly GlanceThemeName[] {
	return slot ? getThemeCatalogForSlot(slot).map((theme) => theme.id) : GLANCE_THEME_IDS;
}

export function getThemeCount(slot?: GlanceThemeSlot): number {
	return themeIdsForSlot(slot).length;
}

export function getThemeIndex(theme: GlanceThemeName, slot?: GlanceThemeSlot): number {
	return Math.max(0, themeIdsForSlot(slot).indexOf(theme));
}

export function getThemeIdByIndex(index: number, slot?: GlanceThemeSlot): GlanceThemeName | undefined {
	return themeIdsForSlot(slot)[index];
}

export function getThemeLabel(theme: GlanceThemeName): string {
	return glanceThemeLabel(theme);
}

function descriptorRow(config: GlanceConfig, descriptor: SegmentSettingDescriptor): SettingsRow {
	const row = {
		id: descriptor.id,
		label: descriptor.label,
		value: descriptor.value(config),
		hint: descriptor.hint,
		kind: descriptor.kind,
	};
	if (descriptor.kind === "info") return row;
	return {
		...row,
		apply: (draft) => withConfig(draft, descriptor.mutate),
	};
}

function segmentRows(config: GlanceConfig, id: SegmentId, rows: SettingsRow[]): SettingsRow[] {
	const segment = config.segments.find((candidate) => candidate.id === id);
	return [
		toggleRow(`${id}.enabled`, "Enabled", Boolean(segment?.enabled), "Show or hide this segment.", (draft) => toggleSegment(draft, id)),
		...rows,
	];
}

function segmentDescriptorRows(config: GlanceConfig, id: SegmentId): SettingsRow[] {
	return segmentRows(config, id, getSegmentSettings(id).map((descriptor) => descriptorRow(config, descriptor)));
}

export function getSettingsCategories(config: GlanceConfig): SettingsCategory[] {
	return [
		{ id: "general", label: "General" },
		...config.segments.map((segment) => ({
			id: segment.id,
			label: segmentLabel(segment.id),
			enabled: segment.enabled,
		})),
		{ id: "details", label: "Bottom details" },
	];
}

export function getSettingsRows(config: GlanceConfig, categoryId: SettingsCategoryId): SettingsRow[] {
	switch (categoryId) {
		case "general":
			return [
				toggleRow("general.enabled", "Enabled", config.enabled, "Temporarily disable pi-glance.", (draft) =>
					withConfig(draft, (next) => {
						next.enabled = !next.enabled;
					}),
				),
				cycleRow(
					"general.theme.light",
					"Light theme",
					getThemeLabel(config.theme.light),
					"Palette used for light or unknown Pi theme tone.",
					(draft) =>
						withConfig(draft, (next) => {
							next.theme.light = nextIn(next.theme.light, themeIdsForSlot("light"));
						}),
					{ opensSubview: "themeBrowser", themeSlot: "light" },
				),
				cycleRow(
					"general.theme.dark",
					"Dark theme",
					getThemeLabel(config.theme.dark),
					"Palette used for dark Pi theme tone.",
					(draft) =>
						withConfig(draft, (next) => {
							next.theme.dark = nextIn(next.theme.dark, themeIdsForSlot("dark"));
						}),
					{ opensSubview: "themeBrowser", themeSlot: "dark" },
				),
				cycleRow("general.icons", "Icons", config.icons, "Plain text or Nerd Font icons with fallback.", (draft) =>
					withConfig(draft, (next) => {
						next.icons = nextIn(next.icons, ICON_MODE_VALUES);
					}),
				),
				cycleRow("general.minInputRows", "Min input rows", `${config.editor.minContentRows}`, "Set the resting editor height.", (draft) =>
					withConfig(draft, (next) => {
						next.editor.minContentRows = nextNumber(next.editor.minContentRows, MIN_CONTENT_ROWS);
					}),
				),
				cycleRow("general.topMarginRows", "Top spacing", topMarginRowsLabel(config.editor.topMarginRows), "Set breathing room above the editor.", (draft) =>
					withConfig(draft, (next) => {
						next.editor.topMarginRows = nextNumber(next.editor.topMarginRows, EDITOR_TOP_MARGIN_ROW_VALUES);
					}),
				),
				cycleRow("general.workspaceLabel", "Workspace label", config.display.workspaceLabel, "Show name, smart ~/ path, or safe path.", (draft) =>
					withConfig(draft, (next) => {
						next.display.workspaceLabel = nextIn(next.display.workspaceLabel, WORKSPACE_LABEL_MODE_VALUES);
					}),
				),
			];
		case "details":
			return [
				toggleRow("bottomDetails.autoCompact", "Auto compact", config.bottomDetails.showAutoCompact, "Highlight auto-compaction when Pi enables it.", (draft) =>
					withConfig(draft, (next) => {
						next.bottomDetails.showAutoCompact = !next.bottomDetails.showAutoCompact;
					}),
				),
			];
		case "git":
		case "context":
		case "cost":
		case "tokens":
		case "model":
		case "throughput":
			return segmentDescriptorRows(config, categoryId);
		default:
			return [];
	}
}
