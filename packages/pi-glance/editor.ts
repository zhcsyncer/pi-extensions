import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { stripControls } from "./format.js";
import { measureInputSurfaceFrame, renderInputSurfaceFrame } from "./input-surface-frame.js";
import { renderGlanceLine } from "./status-line.js";
import { formatSurfaceScrollIndicator } from "./surface-layout.js";
import { resolveGlanceRenderStyles, type GlanceRenderStyleContext, type ResolvedGlanceStyles } from "./theme-adapter.js";
import type { GlanceConfig, GlanceState } from "./types.js";

export interface GlanceEditorOptions {
	readonly editorOptions?: EditorOptions;
	readonly renderStyleContext?: GlanceRenderStyleContext;
}

function stripBorderColor(line: string, borderColor: (text: string) => string): string {
	const sample = borderColor("─");
	if (!sample || sample === "─") return stripControls(line);
	const markerIndex = sample.indexOf("─");
	if (markerIndex < 0) return stripControls(line);
	const prefix = sample.slice(0, markerIndex);
	const suffix = sample.slice(markerIndex + 1);
	let out = line;
	if (prefix) out = out.split(prefix).join("");
	if (suffix) out = out.split(suffix).join("");
	return stripControls(out);
}

function isHorizontalBorder(line: string, borderColor: (text: string) => string): boolean {
	const plain = stripBorderColor(line, borderColor).trim();
	return (
		plain.length > 0 &&
		plain.includes("─") &&
		[...plain].every((char) => char === "─" || char === "↑" || char === "↓" || char === " " || /[0-9a-z]/i.test(char))
	);
}

function normalizeRenderedLine(line: string, width: number): string {
	const lineWidth = visibleWidth(line);
	if (lineWidth === width) return line;
	if (lineWidth < width) return `${line}${" ".repeat(width - lineWidth)}`;
	return truncateToWidth(line, width, "");
}

function indentAutocompleteLine(line: string, width: number, indentWidth: number): string {
	const indent = " ".repeat(indentWidth);
	return normalizeRenderedLine(`${indent}${line}`, width);
}

export class GlanceEditor extends CustomEditor {
	private cachedVersion = -1;
	private cachedConfig?: GlanceConfig;
	private cachedWidth = -1;
	private cachedProviderCount = -1;
	private cachedStatusStyleKey = "";
	private cachedStatus = "";

	constructor(
		tui: TUI,
		theme: EditorTheme,
		private readonly appKeybindings: KeybindingsManager,
		private readonly getState: () => GlanceState,
		private readonly getConfig: () => GlanceConfig,
		private readonly onThinkingLevelMaybeChanged?: () => void,
		private readonly glanceOptions?: GlanceEditorOptions,
	) {
		super(tui, theme, appKeybindings, glanceOptions?.editorOptions);
	}

	handleInput(data: string): void {
		const isThinkingCycle = this.appKeybindings.matches(data, "app.thinking.cycle");
		super.handleInput(data);
		if (isThinkingCycle) this.onThinkingLevelMaybeChanged?.();
	}

	private currentStyles(config: GlanceConfig = this.getConfig()): ResolvedGlanceStyles {
		return resolveGlanceRenderStyles(config.theme, this.glanceOptions?.renderStyleContext);
	}

	private renderStatus(width: number, styles: ResolvedGlanceStyles): string {
		const state = this.getState();
		const config = this.getConfig();
		if (
			this.cachedWidth === width &&
			this.cachedVersion === state.version &&
			this.cachedConfig === config &&
			this.cachedProviderCount === state.providers.availableCount &&
			this.cachedStatusStyleKey === styles.cacheKey
		) {
			return this.cachedStatus;
		}
		const status = renderGlanceLine(state, config, width, state.providers.availableCount, { styles });
		this.cachedWidth = width;
		this.cachedVersion = state.version;
		this.cachedConfig = config;
		this.cachedProviderCount = state.providers.availableCount;
		this.cachedStatusStyleKey = styles.cacheKey;
		this.cachedStatus = status;
		return status;
	}

	private extractScrollIndicator(line: string, width: number): string | undefined {
		return formatSurfaceScrollIndicator(stripBorderColor(line, this.borderColor), width);
	}

	render(width: number): string[] {
		const config = this.getConfig();
		if (!config.enabled) {
			return super.render(width);
		}

		const styles = this.currentStyles(config);
		const metrics = measureInputSurfaceFrame(width);
		const lines = super.render(metrics.editorContentWidth);
		if (lines.length < 2) return lines;

		const isFocused = this.focused;

		const topOriginal = lines[0] ?? "";
		let bottomIndex = -1;
		for (let i = 1; i < lines.length; i++) {
			if (isHorizontalBorder(lines[i] ?? "", this.borderColor)) bottomIndex = i;
		}
		if (bottomIndex < 1) return lines;

		const bottomOriginal = lines[bottomIndex] ?? "";
		const body = lines.slice(1, bottomIndex);
		const autocomplete = lines.slice(bottomIndex + 1);
		const contentLines = body.length > 0 ? body : [""];
		const frame = renderInputSurfaceFrame({
			state: this.getState(),
			config,
			width,
			styles,
			body: { kind: "editor", lines: contentLines },
			chrome: {
				focus: isFocused ? "focused" : "unfocused",
				topScrollIndicator: this.extractScrollIndicator(topOriginal, metrics.safeWidth),
				bottomScrollIndicator: this.extractScrollIndicator(bottomOriginal, metrics.safeWidth),
			},
			status: {
				render: (budget, frameStyles) => this.renderStatus(budget, frameStyles),
			},
		});

		for (const line of autocomplete) {
			frame.push(indentAutocompleteLine(line, metrics.safeWidth, metrics.autocompleteIndent));
		}
		return frame;
	}
}
