import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorOptions, type EditorTheme, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { stripControls } from "./format.js";
import { measureInputSurfaceFrame, renderInputSurfaceFrameWithWorktree, type WorktreeRegion } from "./input-surface-frame.js";
import { formatSurfaceScrollIndicator } from "./surface-layout.js";
import { resolveGlanceRenderStyles, type GlanceRenderStyleContext, type ResolvedGlanceStyles } from "./theme-adapter.js";
import type { GlanceConfig, GlanceState } from "./types.js";

export interface GlanceEditorOptions {
	readonly editorOptions?: EditorOptions;
	readonly renderStyleContext?: GlanceRenderStyleContext;
	readonly onForeground?: () => void;
	readonly getStashOccupied?: () => boolean;
	readonly onWorktreeReview?: () => void;
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
	private readonly surfaceTui: TUI;
	private nativeRender = false;
	private mouseFrame?: {
		width: number; height: number; contentWidth: number; contentX: number;
		bodyStart: number; bodyRows: number; autocompleteStart: number; baseAutocompleteStart: number; baseHeight: number;
		config: GlanceConfig; version: number; summaryMode: GlanceConfig["git"]["worktreeSummary"];
		region?: WorktreeRegion;
	};
	private lastFocused: boolean | undefined;

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
		this.surfaceTui = tui;
	}

	handleInput(data: string): void {
		this.mouseFrame = undefined;
		const isThinkingCycle = this.appKeybindings.matches(data, "app.thinking.cycle");
		super.handleInput(data);
		if (isThinkingCycle) this.onThinkingLevelMaybeChanged?.();
	}

	invalidate(): void {
		super.invalidate();
		this.mouseFrame = undefined;
		this.nativeRender = false;
	}

	private bashModeLabel(): string | undefined {
		const text = this.getText().trimStart();
		if (text.startsWith("!!")) return "Bash · no context";
		if (text.startsWith("!")) return "Bash";
		return undefined;
	}

	private currentStyles(config: GlanceConfig = this.getConfig()): ResolvedGlanceStyles {
		return resolveGlanceRenderStyles(config, this.glanceOptions?.renderStyleContext);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const config = this.getConfig();
		if (this.nativeRender && !config.enabled) return super.handleMouse(event);
		const frame = this.mouseFrame;
		if (!frame || !config.enabled || frame.config !== config || frame.version !== this.getState().version
			|| event.width !== frame.width || event.height !== frame.height || frame.summaryMode !== config.git.worktreeSummary) return undefined;
		const region = frame.region;
		if (this.surfaceTui.mode === "fullscreen" && config.segments.some((segment) => segment.id === "git" && segment.enabled)
			&& event.type === "click" && event.button === "left" && region
			&& event.y === region.row && event.x >= region.start && event.x < region.end) {
			this.glanceOptions?.onWorktreeReview?.();
			return { handled: true };
		}
		// Only real base-editor rows are forwarded; outer chrome and padded blank rows aren't autocomplete.
		if (event.x < frame.contentX || event.x >= frame.contentX + frame.contentWidth) return undefined;
		let y: number;
		if (event.y >= frame.bodyStart && event.y < frame.bodyStart + frame.bodyRows) y = event.y - frame.bodyStart + 1;
		else if (event.y >= frame.autocompleteStart && event.y < frame.height) y = event.y - frame.autocompleteStart + frame.baseAutocompleteStart;
		else return undefined;
		const result = super.handleMouse({ ...event, x: event.x - frame.contentX, y, width: frame.contentWidth, height: frame.baseHeight });
		// A handled no-op (e.g. wheel at a list boundary) suppresses Pi's next render.
		if (result?.handled && result.render !== false) this.mouseFrame = undefined;
		return result;
	}

	private extractScrollIndicator(line: string, width: number): string | undefined {
		return formatSurfaceScrollIndicator(stripBorderColor(line, this.borderColor), width);
	}

	render(width: number): string[] {
		this.mouseFrame = undefined;
		this.nativeRender = false;
		const config = this.getConfig();
		if (!config.enabled) {
			this.nativeRender = true;
			return super.render(width);
		}

		const styles = this.currentStyles(config);
		const metrics = measureInputSurfaceFrame(width);
		const lines = super.render(metrics.editorContentWidth);
		if (lines.length < 2) return lines;

		const isFocused = this.focused;
		if (this.lastFocused === false && isFocused) this.glanceOptions?.onForeground?.();
		this.lastFocused = isFocused;
		const modeLabel = this.bashModeLabel();

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
		const frame = renderInputSurfaceFrameWithWorktree({
			state: this.getState(),
			config,
			width,
			styles,
			body: { kind: "editor", lines: contentLines },
			chrome: {
				focus: isFocused ? "focused" : "unfocused",
				...(modeLabel ? { border: styles.bashBorder, modeLabel } : {}),
				stashOccupied: this.glanceOptions?.getStashOccupied?.() === true,
				topScrollIndicator: this.extractScrollIndicator(topOriginal, metrics.safeWidth),
				bottomScrollIndicator: this.extractScrollIndicator(bottomOriginal, metrics.safeWidth),
			},
			interactiveWorktree: this.surfaceTui.mode === "fullscreen" && Boolean(this.glanceOptions?.onWorktreeReview),
		});

		const autocompleteStart = frame.lines.length;
		for (const line of autocomplete) {
			frame.lines.push(indentAutocompleteLine(line, metrics.safeWidth, metrics.autocompleteIndent));
		}
		this.mouseFrame = {
			width, height: frame.lines.length, contentWidth: metrics.editorContentWidth, contentX: metrics.autocompleteIndent,
			bodyStart: config.editor.topMarginRows + 1, bodyRows: body.length,
			autocompleteStart, baseAutocompleteStart: bottomIndex + 1, baseHeight: lines.length,
			config, version: this.getState().version, summaryMode: config.git.worktreeSummary, region: frame.worktreeRegion,
		};
		return frame.lines;
	}
}
