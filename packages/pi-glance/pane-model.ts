import { cloneConfig, defaultConfig, moveSegment } from "./config.js";
import {
	getSettingsCategories,
	getSettingsRows,
	getThemeCatalogForSlot,
	getThemeCount,
	getThemeIdByIndex,
	getThemeIndex,
	getThemeLabel,
	type GlanceThemeSlot,
	type SettingsCategory,
	type SettingsCategoryId,
	type SettingsRow,
} from "./settings-catalog.js";
import type { GlanceConfig, GlanceThemeName } from "./types.js";

export type PaneFocus = "categories" | "settings" | "values";
export type PaneSubview = "settings" | "themeBrowser";
export type PaneMoveDirection = "left" | "right" | "up" | "down";

export type PaneIntent =
	| { type: "cancel" }
	| { type: "back" }
	| { type: "move"; direction: PaneMoveDirection }
	| { type: "activate" }
	| { type: "save" }
	| { type: "resetDefaults" }
	| { type: "reorderSegment"; direction: -1 | 1 }
	| { type: "noop" };

export type PaneCompletion = { action: "save"; config: GlanceConfig } | { action: "cancel" };

export interface ThemeBrowserState {
	slot: GlanceThemeSlot;
	highlightedThemeIndex: number;
	restoreTheme: GlanceThemeName;
	returnFocus: PaneFocus;
	returnCategoryIndex: number;
	returnSettingIndex: number;
}

export interface PaneModelState {
	initial: GlanceConfig;
	draft: GlanceConfig;
	focus: PaneFocus;
	categoryIndex: number;
	settingIndex: number;
	status: string;
	subview: PaneSubview;
	themeBrowser?: ThemeBrowserState;
}

export interface PaneUpdateResult {
	model: PaneModelState;
	requestRender: boolean;
	completion?: PaneCompletion;
}

export interface HelpShortcut {
	key: string;
	label: string;
}

export type SettingsRowKind = SettingsRow["kind"];

export type CategoryViewModel = SettingsCategory & {
	selected: boolean;
	hasFocus: boolean;
};

export interface SettingViewModel {
	id: string;
	label: string;
	value: string;
	hint: string;
	kind: SettingsRowKind;
	opensSubview?: PaneSubview;
	editable: boolean;
	selected: boolean;
	labelHasFocus: boolean;
	valueHasFocus: boolean;
}

export interface ThemeBrowserThemeViewModel {
	id: GlanceThemeName;
	label: string;
	group: string;
	groupLabel: string;
	tone: string;
	tags: readonly string[];
	detailTags: readonly string[];
	description: string;
	detailDescription: string;
	selected: boolean;
	previewed: boolean;
	restored: boolean;
	saved: boolean;
}

export interface ThemeBrowserViewModel {
	slot: GlanceThemeSlot;
	slotLabel: string;
	highlightedThemeIndex: number;
	savedTheme: GlanceThemeName;
	savedLabel: string;
	restoreTheme: GlanceThemeName;
	restoreLabel: string;
	previewTheme: GlanceThemeName;
	previewLabel: string;
	themes: ThemeBrowserThemeViewModel[];
}

export interface GlancePaneViewModel {
	dirty: boolean;
	status: string;
	subview: PaneSubview;
	categories: CategoryViewModel[];
	selectedCategory?: SettingsCategory;
	settingsTitle: string;
	settings: SettingViewModel[];
	selectedHint?: string;
	themeBrowser?: ThemeBrowserViewModel;
	help: HelpShortcut[];
}

const PANE_FOCUS_ORDER: PaneFocus[] = ["categories", "settings", "values"];

function sameConfig(a: GlanceConfig, b: GlanceConfig): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function categoriesFor(model: PaneModelState): SettingsCategory[] {
	return getSettingsCategories(model.draft);
}

function rowsFor(model: PaneModelState, categoryId: SettingsCategoryId): SettingsRow[] {
	return getSettingsRows(model.draft, categoryId);
}

function selectedCategory(model: PaneModelState): SettingsCategory | undefined {
	return categoriesFor(model)[model.categoryIndex];
}

function withModel(model: PaneModelState, changes: Partial<PaneModelState>): PaneModelState {
	return { ...model, ...changes };
}

function result(model: PaneModelState, requestRender: boolean, completion?: PaneCompletion): PaneUpdateResult {
	return completion ? { model, requestRender, completion } : { model, requestRender };
}

function themeSlotLabel(slot: GlanceThemeSlot): string {
	return slot === "light" ? "Light" : "Dark";
}

function configTheme(config: GlanceConfig, slot: GlanceThemeSlot): GlanceThemeName {
	return config.theme[slot];
}

function withConfigTheme(config: GlanceConfig, slot: GlanceThemeSlot, theme: GlanceThemeName): GlanceConfig {
	return { ...config, theme: { ...config.theme, [slot]: theme } };
}

function themeBrowserHelpShortcuts(): HelpShortcut[] {
	return [
		{ key: "↑↓", label: "preview" },
		{ key: "Enter", label: "accept" },
		{ key: "Esc/Left", label: "restore" },
		{ key: "S", label: "save" },
	];
}

function helpShortcuts(focus: PaneFocus, width: number): HelpShortcut[] {
	const stable: HelpShortcut[] = [
		{ key: "←→↑↓", label: "move" },
		{ key: "S", label: "save" },
		{ key: "R", label: "reset" },
	];

	const isNarrow = width < 72;

	switch (focus) {
		case "categories":
			if (isNarrow) {
				return [
					{ key: "S", label: "save" },
					{ key: "J/K", label: "reorder" },
					{ key: "Esc", label: "cancel" },
				];
			}
			return [...stable, { key: "J/K", label: "reorder" }, { key: "Esc", label: "cancel" }];
		case "settings":
			if (isNarrow) {
				return [
					{ key: "S", label: "save" },
					{ key: "Esc", label: "back" },
				];
			}
			return [...stable, { key: "Esc", label: "back" }];
		case "values":
			if (isNarrow) {
				return [
					{ key: "S", label: "save" },
					{ key: "Enter", label: "change" },
					{ key: "Esc", label: "back" },
				];
			}
			return [...stable, { key: "Enter", label: "change" }, { key: "Esc", label: "back" }];
	}
}

function closeThemeBrowser(model: PaneModelState, draft: GlanceConfig, status: string): PaneModelState {
	const browser = model.themeBrowser;
	if (!browser) return model;
	return withModel(model, {
		draft,
		focus: browser.returnFocus,
		categoryIndex: browser.returnCategoryIndex,
		settingIndex: browser.returnSettingIndex,
		status,
		subview: "settings",
		themeBrowser: undefined,
	});
}

function acceptThemeBrowser(model: PaneModelState): PaneModelState {
	if (!model.themeBrowser) return model;
	const slot = model.themeBrowser.slot;
	return closeThemeBrowser(model, model.draft, `${themeSlotLabel(slot)} theme → ${getThemeLabel(configTheme(model.draft, slot))}. Press S to save.`);
}

function restoreThemeBrowser(model: PaneModelState): PaneModelState {
	if (!model.themeBrowser) return model;
	return closeThemeBrowser(model, withConfigTheme(model.draft, model.themeBrowser.slot, model.themeBrowser.restoreTheme), "Theme preview discarded.");
}

function moveThemeBrowserHighlight(model: PaneModelState, direction: PaneMoveDirection): PaneModelState {
	if (!model.themeBrowser) return model;
	if (direction === "left") return restoreThemeBrowser(model);
	if (direction === "right") return model;

	const slot = model.themeBrowser.slot;
	const count = getThemeCount(slot);
	const step = direction === "up" ? -1 : 1;
	const highlightedThemeIndex = (model.themeBrowser.highlightedThemeIndex + step + count) % count;
	const theme = getThemeIdByIndex(highlightedThemeIndex, slot) ?? configTheme(model.draft, slot);
	return withModel(model, {
		draft: withConfigTheme(model.draft, slot, theme),
		themeBrowser: {
			...model.themeBrowser,
			highlightedThemeIndex,
		},
	});
}

function moveFocus(model: PaneModelState, direction: PaneMoveDirection): PaneModelState {
	if (model.subview === "themeBrowser") return moveThemeBrowserHighlight(model, direction);

	const categories = categoriesFor(model);
	let next = model;

	switch (direction) {
		case "left": {
			const index = PANE_FOCUS_ORDER.indexOf(model.focus);
			let categoryIndex = model.categoryIndex;
			if (model.focus === "settings") {
				categoryIndex = categories.length === 0 ? 0 : Math.min(model.settingIndex, categories.length - 1);
			}
			return withModel(model, {
				categoryIndex,
				focus: PANE_FOCUS_ORDER[Math.max(0, index - 1)] ?? "categories",
			});
		}
		case "right": {
			const index = PANE_FOCUS_ORDER.indexOf(model.focus);
			let settingIndex = model.settingIndex;
			if (model.focus === "categories") {
				const category = categories[model.categoryIndex];
				const rowCount = category ? rowsFor(model, category.id).length : 0;
				settingIndex = rowCount === 0 ? 0 : Math.min(model.categoryIndex, rowCount - 1);
			}
			return withModel(model, {
				settingIndex,
				focus: PANE_FOCUS_ORDER[Math.min(PANE_FOCUS_ORDER.length - 1, index + 1)] ?? "values",
			});
		}
		case "up":
			if (model.focus === "categories") {
				const count = categories.length;
				const categoryIndex = count === 0 ? 0 : (model.categoryIndex - 1 + count) % count;
				const category = categories[categoryIndex];
				const rowCount = category ? rowsFor(withModel(model, { categoryIndex }), category.id).length : 0;
				next = withModel(model, {
					categoryIndex,
					settingIndex: rowCount === 0 ? 0 : Math.min(categoryIndex, rowCount - 1),
				});
			} else {
				const category = categories[model.categoryIndex];
				const count = category ? rowsFor(model, category.id).length : 0;
				next = withModel(model, {
					settingIndex: count === 0 ? 0 : (model.settingIndex - 1 + count) % count,
				});
			}
			return next;
		case "down":
			if (model.focus === "categories") {
				const count = categories.length;
				const categoryIndex = count === 0 ? 0 : (model.categoryIndex + 1) % count;
				const category = categories[categoryIndex];
				const rowCount = category ? rowsFor(withModel(model, { categoryIndex }), category.id).length : 0;
				next = withModel(model, {
					categoryIndex,
					settingIndex: rowCount === 0 ? 0 : Math.min(categoryIndex, rowCount - 1),
				});
			} else {
				const category = categories[model.categoryIndex];
				const count = category ? rowsFor(model, category.id).length : 0;
				next = withModel(model, {
					settingIndex: count === 0 ? 0 : (model.settingIndex + 1) % count,
				});
			}
			return next;
	}
}

function selectedRow(model: PaneModelState): SettingsRow | undefined {
	const category = selectedCategory(model);
	if (!category) return undefined;
	return rowsFor(model, category.id)[model.settingIndex];
}

function openThemeBrowser(model: PaneModelState, row: SettingsRow): PaneModelState {
	const slot = row.themeSlot ?? "light";
	const highlightedThemeIndex = getThemeIndex(configTheme(model.draft, slot), slot);
	return withModel(model, {
		subview: "themeBrowser",
		themeBrowser: {
			slot,
			highlightedThemeIndex,
			restoreTheme: configTheme(model.draft, slot),
			returnFocus: model.focus,
			returnCategoryIndex: model.categoryIndex,
			returnSettingIndex: model.settingIndex,
		},
	});
}

function activateCurrent(model: PaneModelState): PaneModelState {
	const category = selectedCategory(model);
	if (!category) return model;

	const row = selectedRow(model);
	if (!row) return model;

	if (row.opensSubview === "themeBrowser") return openThemeBrowser(model, row);

	if (!row.apply) {
		return withModel(model, { status: row.hint ?? `${row.label} is informational.` });
	}

	const draft = row.apply(model.draft);
	const nextRow = getSettingsRows(draft, category.id)[model.settingIndex];
	return withModel(model, {
		draft,
		status: `${row.label} → ${nextRow?.value ?? "updated"}. Press S to save.`,
	});
}

function reorderCurrentSegment(model: PaneModelState, direction: -1 | 1): PaneModelState {
	if (model.categoryIndex === 0) {
		return withModel(model, { status: "Cannot move General settings." });
	}

	const segment = model.draft.segments[model.categoryIndex - 1];
	if (!segment) return model;

	const targetCategoryIndex = model.categoryIndex + direction;
	if (targetCategoryIndex < 1 || targetCategoryIndex > model.draft.segments.length) {
		return withModel(model, { status: direction < 0 ? "Already at the top." : "Already at the bottom." });
	}

	return withModel(model, {
		draft: moveSegment(model.draft, segment.id, direction),
		categoryIndex: targetCategoryIndex,
		status: "Segment order updated. Press S to save.",
	});
}

export function createPaneModel(initial: GlanceConfig): PaneModelState {
	return {
		initial: cloneConfig(initial),
		draft: cloneConfig(initial),
		focus: "categories",
		categoryIndex: 0,
		settingIndex: 0,
		status: "",
		subview: "settings",
	};
}

export function paneIsDirty(model: PaneModelState): boolean {
	return !sameConfig(model.draft, model.initial);
}

function createThemeBrowserViewModel(model: PaneModelState): ThemeBrowserViewModel | undefined {
	if (model.subview !== "themeBrowser" || !model.themeBrowser) return undefined;
	const slot = model.themeBrowser.slot;
	const savedTheme = configTheme(model.initial, slot);
	const previewTheme = configTheme(model.draft, slot);
	return {
		slot,
		slotLabel: `${themeSlotLabel(slot)} theme`,
		highlightedThemeIndex: model.themeBrowser.highlightedThemeIndex,
		savedTheme,
		savedLabel: getThemeLabel(savedTheme),
		restoreTheme: model.themeBrowser.restoreTheme,
		restoreLabel: getThemeLabel(model.themeBrowser.restoreTheme),
		previewTheme,
		previewLabel: getThemeLabel(previewTheme),
		themes: getThemeCatalogForSlot(slot).map((theme, index) => ({
			id: theme.id,
			label: theme.label,
			group: theme.group,
			groupLabel: theme.groupLabel,
			tone: theme.tone,
			tags: theme.tags,
			detailTags: theme.detailTags,
			description: theme.description,
			detailDescription: theme.detailDescription,
			selected: index === model.themeBrowser?.highlightedThemeIndex,
			previewed: theme.id === previewTheme,
			restored: theme.id === model.themeBrowser?.restoreTheme,
			saved: theme.id === savedTheme,
		})),
	};
}

export function createPaneViewModel(model: PaneModelState, width: number): GlancePaneViewModel {
	const categories = categoriesFor(model);
	const selected = categories[model.categoryIndex];
	const settings = selected ? rowsFor(model, selected.id) : [];

	return {
		dirty: paneIsDirty(model),
		status: model.status,
		subview: model.subview,
		categories: categories.map((category, index) => ({
			...category,
			selected: index === model.categoryIndex,
			hasFocus: model.focus === "categories",
		})),
		selectedCategory: selected,
		settingsTitle: selected ? (selected.id === "general" ? "General" : selected.label) : "",
		settings: settings.map((row, index) => ({
			id: row.id,
			label: row.label,
			value: row.value,
			hint: row.hint,
			kind: row.kind,
			opensSubview: row.opensSubview,
			editable: Boolean(row.apply),
			selected: index === model.settingIndex,
			labelHasFocus: model.focus === "settings",
			valueHasFocus: model.focus === "values",
		})),
		selectedHint: settings[model.settingIndex]?.hint,
		themeBrowser: createThemeBrowserViewModel(model),
		help: model.subview === "themeBrowser" ? themeBrowserHelpShortcuts() : helpShortcuts(model.focus, width),
	};
}

export function updatePaneModel(model: PaneModelState, intent: PaneIntent): PaneUpdateResult {
	switch (intent.type) {
		case "cancel":
			return result(model, false, { action: "cancel" });
		case "back":
			if (model.subview === "themeBrowser") return result(restoreThemeBrowser(model), true);
			if (model.focus === "categories") return result(model, false, { action: "cancel" });
			return result(withModel(model, { focus: "categories" }), true);
		case "move":
			return result(moveFocus(model, intent.direction), true);
		case "activate":
			if (model.subview === "themeBrowser") return result(acceptThemeBrowser(model), true);
			if (model.focus !== "values") return result(model, false);
			return result(activateCurrent(model), true);
		case "save":
			return result(model, false, { action: "save", config: cloneConfig(model.draft) });
		case "resetDefaults":
			return result(
				withModel(model, {
					draft: defaultConfig(),
					focus: "categories",
					categoryIndex: 0,
					settingIndex: 0,
					status: "Defaults restored locally. Press S to save or Esc to discard.",
					subview: "settings",
					themeBrowser: undefined,
				}),
				true,
			);
		case "reorderSegment":
			if (model.focus !== "categories") return result(model, false);
			return result(reorderCurrentSegment(model, intent.direction), true);
		case "noop":
			return result(model, false);
	}
}
