import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	createPaneModel,
	createPaneViewModel,
	updatePaneModel,
	type CategoryViewModel,
	type GlancePaneViewModel,
	type HelpShortcut,
	type PaneIntent,
	type PaneModelState,
	type SettingViewModel,
	type ThemeBrowserThemeViewModel,
} from "./pane-model.js";
import { renderInputSurface, renderInputSurfacePreview } from "./renderer.js";
import type { GlanceRenderStyleContext } from "./theme-adapter.js";
import type { GlanceConfig, GlanceState } from "./types.js";

type PaneResult = { action: "save"; config: GlanceConfig } | { action: "cancel" };
type Done = (result: GlanceConfig | null) => void;
type Tone = (text: string) => string;

export interface GlancePaneOptions {
	readonly renderStyleContext?: GlanceRenderStyleContext;
}

interface PaneColors {
	accent: Tone;
	muted: Tone;
	dim: Tone;
	warn: Tone;
	success: Tone;
}

interface PaneLayout {
	width: number;
	contentWidth: number;
	outerPadding: string;
	categoryWidth: number;
	settingLabelWidth: number;
	valueWidth: number;
	settingsWidth: number;
	asideWidth: number;
	columnGap: string;
	asideGap: string;
	asideSeparator: string;
	showAside: boolean;
}

const PANE_SPACING = {
	outerPadding: 2,
	contentInset: 4,
	categoryWidth: 14,
	settingLabelWidth: 20,
	valueWidth: 16,
	minValueWidth: 8,
	asideWidth: 36,
	minAsideWidth: 22,
	columnGap: 4,
	asideGap: 4,
	minContentWidth: 10,
	asideSeparator: "│",
} as const;

function plainLine(parts: string[], width: number): string {
	return truncateToWidth(parts.join(""), width, "…");
}

function makePaneLayout(width: number): PaneLayout {
	const outerPaddingWidth = width < 72 ? 1 : PANE_SPACING.outerPadding;
	const contentWidth = Math.max(PANE_SPACING.minContentWidth, width - outerPaddingWidth * 2);
	const categoryWidth = PANE_SPACING.categoryWidth;
	const columnGapWidth = width < 72 ? 2 : PANE_SPACING.columnGap;
	const asideFrameWidth = PANE_SPACING.asideGap + visibleWidth(PANE_SPACING.asideSeparator) + 1;
	const settingLabelWidth = PANE_SPACING.settingLabelWidth;
	const labelWidthWithCursor = settingLabelWidth + 2;
	const valueRoom = contentWidth - categoryWidth - columnGapWidth - labelWidthWithCursor - columnGapWidth;
	const valueWidth = Math.max(PANE_SPACING.minValueWidth, Math.min(PANE_SPACING.valueWidth, valueRoom));
	const settingsWidth = labelWidthWithCursor + columnGapWidth + valueWidth;
	const coreWidth = categoryWidth + columnGapWidth + settingsWidth;
	const asideRoom = contentWidth - coreWidth - asideFrameWidth;
	const showAside = asideRoom >= PANE_SPACING.minAsideWidth;
	const maxAsideWidth = width >= 120 ? 48 : PANE_SPACING.asideWidth;
	const asideWidth = showAside ? Math.min(maxAsideWidth, asideRoom) : 0;

	return {
		width,
		contentWidth,
		outerPadding: " ".repeat(outerPaddingWidth),
		categoryWidth,
		settingLabelWidth,
		valueWidth,
		settingsWidth,
		asideWidth,
		columnGap: " ".repeat(columnGapWidth),
		asideGap: " ".repeat(PANE_SPACING.asideGap),
		asideSeparator: PANE_SPACING.asideSeparator,
		showAside,
	};
}

function paneLine(layout: PaneLayout, parts: string[]): string {
	return plainLine([layout.outerPadding, ...parts], layout.width);
}

function padRightAnsi(text: string, width: number): string {
	const extra = Math.max(0, width - visibleWidth(text));
	return `${text}${" ".repeat(extra)}`;
}

function spreadAnsi(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (leftWidth + rightWidth + 1 > width) {
		const leftBudget = Math.max(0, width - rightWidth - 1);
		if (leftBudget <= 0) return truncateToWidth(right, width, "…");
		return `${truncateToWidth(left, leftBudget, "…")} ${right}`;
	}
	return `${left}${" ".repeat(Math.max(0, width - leftWidth - rightWidth))}${right}`;
}

function makePaneColors(theme: Theme): PaneColors {
	return {
		accent: (s: string) => theme.fg("accent", s),
		muted: (s: string) => theme.fg("muted", s),
		dim: (s: string) => theme.fg("dim", s),
		warn: (s: string) => theme.fg("warning", s),
		success: (s: string) => theme.fg("success", s),
	};
}

function shortcut(colors: PaneColors, key: string, label: string): string {
	return `${colors.accent(`[${key}]`)} ${colors.dim(label)}`;
}

function helpText(help: HelpShortcut[], colors: PaneColors): string {
	return help.map((item) => shortcut(colors, item.key, item.label)).join(colors.dim("  ·  "));
}

function focusGap(gap: string, colors: PaneColors): string {
	const gapWidth = visibleWidth(gap);
	if (gapWidth <= 1) return colors.accent("›");
	return `${" ".repeat(Math.max(0, gapWidth - 2))}${colors.accent("› ")}`;
}

function paneIntentFromKey(data: string): PaneIntent | undefined {
	if (matchesKey(data, Key.ctrl("c"))) return { type: "cancel" };
	if (matchesKey(data, Key.escape) || data === "q" || data === "Q") return { type: "back" };
	if (matchesKey(data, Key.left)) return { type: "move", direction: "left" };
	if (matchesKey(data, Key.right)) return { type: "move", direction: "right" };
	if (matchesKey(data, Key.up)) return { type: "move", direction: "up" };
	if (matchesKey(data, Key.down)) return { type: "move", direction: "down" };
	if (matchesKey(data, Key.enter)) return { type: "activate" };
	if (matchesKey(data, Key.space)) return { type: "noop" };
	if (data === "s" || data === "S") return { type: "save" };
	if (data === "r" || data === "R") return { type: "resetDefaults" };
	if (data === "j" || data === "J") return { type: "reorderSegment", direction: 1 };
	if (data === "k" || data === "K") return { type: "reorderSegment", direction: -1 };
	return undefined;
}

class GlanceConfigPane implements Component {
	private model: PaneModelState;

	constructor(
		initial: GlanceConfig,
		private readonly theme: Theme,
		private readonly done: Done,
		private readonly requestRender: () => void,
		private readonly previewState?: GlanceState,
		private readonly options: GlancePaneOptions = {},
	) {
		this.model = createPaneModel(initial);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const intent = paneIntentFromKey(data);
		if (!intent) return;

		const update = updatePaneModel(this.model, intent);
		this.model = update.model;

		if (update.completion) {
			this.done(update.completion.action === "cancel" ? null : update.completion.config);
			return;
		}

		if (update.requestRender) this.requestRender();
	}

	private renderPreview(lines: string[], layout: PaneLayout): void {
		const previewOptions = {
			contentLines: ["Ask pi to improve the input surface..."],
			focused: true,
			...(this.options.renderStyleContext ?? {}),
			...(this.model.themeBrowser ? { ambientTone: this.model.themeBrowser.slot } : {}),
		};
		const preview = this.previewState
			? renderInputSurface(this.previewState, this.model.draft, layout.width, previewOptions)
			: renderInputSurfacePreview(this.model.draft, layout.width, previewOptions);
		for (const previewLine of preview) {
			lines.push(previewLine);
		}
	}

	private renderCategoryRow(cat: CategoryViewModel, colors: PaneColors): string {
		let labelTone = colors.muted;

		if (cat.selected) {
			labelTone = cat.hasFocus ? colors.accent : colors.muted;
		} else if (cat.enabled === false) {
			labelTone = colors.dim;
		}

		let cursor = "  ";
		if (cat.selected) {
			cursor = cat.hasFocus ? colors.accent("» ") : colors.dim("› ");
		}
		return `${cursor}${labelTone(cat.label)}`;
	}

	private renderLeftPane(model: GlancePaneViewModel, colors: PaneColors): string[] {
		return model.categories.map((cat) => this.renderCategoryRow(cat, colors));
	}

	private renderSettingValue(row: SettingViewModel, colors: PaneColors): string {
		if (row.kind === "info") return colors.dim(row.value);
		const valueTone = row.selected && row.valueHasFocus ? colors.accent : row.value === "on" ? colors.success : row.value === "off" ? colors.dim : colors.muted;
		let displayValue = row.value;
		if (row.selected && row.valueHasFocus) {
			displayValue = `[ ${row.value} ]`;
		}
		return valueTone(displayValue);
	}

	private renderSettingRow(row: SettingViewModel, layout: PaneLayout, colors: PaneColors): string {
		let labelTone = colors.muted;

		if (row.selected) {
			labelTone = row.labelHasFocus ? colors.accent : colors.muted;
		} else if (row.kind === "info") {
			labelTone = colors.dim;
		}

		const label = truncateToWidth(row.label, layout.settingLabelWidth, "…");
		const cursor = row.selected ? (row.labelHasFocus ? colors.accent("» ") : colors.dim("› ")) : "  ";
		const paddedLabel = padRightAnsi(`${cursor}${labelTone(label)}`, layout.settingLabelWidth + 2);
		const gap = row.selected && row.valueHasFocus ? focusGap(layout.columnGap, colors) : layout.columnGap;
		const valueStr = this.renderSettingValue(row, colors);
		const value = truncateToWidth(valueStr, layout.valueWidth, "…");
		return `${paddedLabel}${gap}${value}`;
	}

	private renderSettingsPane(model: GlancePaneViewModel, layout: PaneLayout, colors: PaneColors): string[] {
		if (!model.selectedCategory) return [];

		if (model.settings.length === 0) {
			return [colors.dim("No settings available.")];
		}

		return model.settings.map((row) => this.renderSettingRow(row, layout, colors));
	}

	private renderThemeBrowserRow(theme: ThemeBrowserThemeViewModel, layout: PaneLayout, colors: PaneColors): string {
		const cursor = theme.selected ? colors.accent("» ") : "  ";
		const previewMarker = theme.previewed ? colors.accent("●") : " ";
		const savedMarker = theme.saved ? colors.success("✓") : " ";
		const restoreMarker = theme.restored && !theme.saved ? colors.muted("↩") : " ";
		const labelTone = theme.selected ? colors.accent : theme.previewed ? colors.muted : colors.dim;
		const markers = `${cursor}${previewMarker} ${savedMarker}${restoreMarker} `;
		const markerWidth = visibleWidth(markers);
		const label = truncateToWidth(theme.label, Math.max(8, layout.contentWidth - markerWidth), "…");
		return paneLine(layout, [`${markers}${labelTone(label)}`]);
	}

	private renderThemeBrowserDetail(theme: ThemeBrowserThemeViewModel, layout: PaneLayout, colors: PaneColors): string[] {
		const tags = theme.detailTags.join(" · ");
		const summary = ["Selected", theme.groupLabel, tags].filter(Boolean).join(" · ");
		return [paneLine(layout, [colors.muted(summary)]), paneLine(layout, [colors.dim(theme.detailDescription)])];
	}

	private renderThemeBrowser(lines: string[], model: GlancePaneViewModel, layout: PaneLayout, colors: PaneColors): void {
		const browser = model.themeBrowser;
		if (!browser) return;

		const selected = browser.themes[browser.highlightedThemeIndex] ?? browser.themes.find((theme) => theme.selected);
		const title = `${browser.slotLabel} · preview ${browser.previewLabel}`;
		const restore = browser.restoreTheme === browser.savedTheme ? `saved ${browser.savedLabel}` : `saved ${browser.savedLabel} · Esc returns ${browser.restoreLabel}`;
		const position = `${browser.highlightedThemeIndex + 1}/${browser.themes.length}`;
		lines.push(paneLine(layout, [spreadAnsi(colors.muted(title), colors.dim(position), layout.contentWidth)]));
		lines.push(paneLine(layout, [colors.dim(restore)]));

		for (const theme of browser.themes) {
			lines.push(this.renderThemeBrowserRow(theme, layout, colors));
		}

		if (selected) {
			lines.push("");
			lines.push(...this.renderThemeBrowserDetail(selected, layout, colors));
		}
	}

	private renderAsidePane(model: GlancePaneViewModel, layout: PaneLayout, colors: PaneColors): string[] {
		const hint = model.selectedHint ? truncateToWidth(model.selectedHint, layout.asideWidth - 2, "…") : "";
		return [colors.muted(model.settingsTitle), hint ? colors.dim(`“${hint}”`) : ""];
	}

	private renderSettingsColumns(lines: string[], model: GlancePaneViewModel, layout: PaneLayout, colors: PaneColors): void {
		const categories = this.renderLeftPane(model, colors);
		const settings = this.renderSettingsPane(model, layout, colors);
		const aside = layout.showAside ? this.renderAsidePane(model, layout, colors) : [];

		const maxLines = Math.max(categories.length, settings.length, aside.length);
		for (let i = 0; i < maxLines; i++) {
			const category = padRightAnsi(categories[i] ?? "", layout.categoryWidth);
			const selectedSetting = model.settings[i];
			const categoryGap = selectedSetting?.selected && selectedSetting.labelHasFocus ? focusGap(layout.columnGap, colors) : layout.columnGap;
			const setting = padRightAnsi(settings[i] ?? "", layout.settingsWidth);
			const asideLine = aside[i] ?? "";
			const asidePart = layout.showAside ? [layout.asideGap, colors.dim(`${layout.asideSeparator} `), asideLine] : [];
			lines.push(paneLine(layout, [category, categoryGap, setting, ...asidePart]));
		}
	}

	private renderSettings(lines: string[], model: GlancePaneViewModel, layout: PaneLayout, colors: PaneColors): void {
		if (model.subview === "themeBrowser") {
			this.renderThemeBrowser(lines, model, layout, colors);
			return;
		}

		this.renderSettingsColumns(lines, model, layout, colors);
		if (!layout.showAside && model.selectedHint) {
			const hint = truncateToWidth(model.selectedHint, layout.contentWidth, "…");
			lines.push("");
			lines.push(paneLine(layout, [colors.dim(`“${hint}”`)]));
		}
	}

	private renderFooter(lines: string[], model: GlancePaneViewModel, layout: PaneLayout, colors: PaneColors): void {
		const footerLeft = helpText(model.help, colors);
		const footerRight = model.dirty ? colors.warn("● Unsaved changes") : colors.success("✓ Saved");
		lines.push(paneLine(layout, [spreadAnsi(footerLeft, footerRight, layout.contentWidth)]));
	}

	render(width: number): string[] {
		const colors = makePaneColors(this.theme);
		const layout = makePaneLayout(width);
		const model = createPaneViewModel(this.model, width);
		const lines: string[] = [];

		if (model.status) lines.push(paneLine(layout, [colors.dim(model.status)]));

		this.renderPreview(lines, layout);
		lines.push("");

		this.renderSettings(lines, model, layout, colors);
		lines.push("");

		this.renderFooter(lines, model, layout, colors);
		return lines;
	}
}

interface GlancePaneUI {
	custom<T>(
		factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (result: T) => void) => Component,
	): Promise<T>;
}

export async function showGlancePane(
	initial: GlanceConfig,
	ctx: { ui: GlancePaneUI },
	previewState?: GlanceState,
	options: GlancePaneOptions = {},
): Promise<PaneResult> {
	return ctx.ui.custom<PaneResult>((tui, theme, _kb, done) => {
		return new GlanceConfigPane(
			initial,
			theme,
			(result) => done(result ? { action: "save", config: result } : { action: "cancel" }),
			() => tui.requestRender(),
			previewState,
			options,
		);
	});
}
