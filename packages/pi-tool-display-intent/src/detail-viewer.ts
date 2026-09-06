import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component, type TuiMouseEvent, type TuiMouseEventResult,
	matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { buildDetailModel, type DetailModel, type DetailRequest, type DetailTab, type DetailField } from "./detail-viewer-model.ts";
import { createDetailDiffRenderer, type DetailDiffTheme } from "./detail-diff.js";
import { colorDetailJson, createDetailMarkdown, layoutDetailFields, wrapDetailLine } from "./detail-content.js";
import type { ToolDisplayConfig } from "./types.js";

export type { DetailRequest } from "./detail-viewer-model.ts";
export { buildDetailModel } from "./detail-viewer-model.ts";

interface Page {
	sourceLines: string[];
	lines: string[];
	wrapWidth: number;
	sourceLineByRow: number[];
	firstRowBySourceLine: number[];
	renderer?: Pick<Component, "render">;
	fields?: readonly DetailField[];
	viewHeight: number;
	top: number;
}
interface ClickButton { start: number; end: number; action: () => void }

export interface DetailViewerOptions {
	getHeight: () => number;
	onClose: () => void;
	onRender: () => void;
	theme?: DetailDiffTheme;
	diffConfig?: ToolDisplayConfig;
}

/** Keep the right-hand status/position visible before shortening low-priority help. */
export function composeDetailLine(left: string, right: string, width: number): string {
	if (width <= 0 || !Number.isFinite(width)) return "";
	if (!right) return truncateToWidth(left, width, "…", true);
	const rightWidth = visibleWidth(right);
	if (rightWidth + 2 >= width) return truncateToWidth(right, width, "…", true);
	return `${truncateToWidth(left, width - rightWidth - 2, "…", true)}  ${right}`;
}

/** A read-only snapshot. Every rich renderer below belongs to this extension. */
export class DetailViewer implements Component {
	private readonly pages = new Map<string, Page>();
	private readonly rawTabs = new Set<number>();
	private selected = 0;
	private lastPrimary = 0;
	private viewportHeight = 1;
	private viewportWidth = 1;
	private closed = false;
	private tabRow = -1;
	private buttons: ClickButton[] = [];

	constructor(readonly model: DetailModel, private readonly options: DetailViewerOptions) {}

	private tab(): DetailTab { return this.model.tabs[this.selected]; }
	private isRaw(): boolean { return this.rawTabs.has(this.selected); }
	private canToggleRaw(): boolean {
		const tab = this.tab();
		return Boolean(tab.diff || tab.presentation !== "text" || tab.rawText !== tab.text);
	}

	private page(): Page {
		const tab = this.tab();
		const raw = this.isRaw();
		const key = `${this.selected}:${raw ? "raw" : "view"}`;
		let page = this.pages.get(key);
		if (!page) {
			let renderer: Pick<Component, "render"> | undefined;
			if (!raw) {
				if (tab.diff) renderer = createDetailDiffRenderer(tab.text, tab.diff.filePath, this.options.theme, this.options.diffConfig, tab.diff.source);
				else if (tab.presentation === "markdown") renderer = createDetailMarkdown(tab.text);
			}
			const text = raw ? tab.rawText : tab.presentation === "json" ? colorDetailJson(tab.text, this.options.theme) : tab.text;
			const fields = !raw && tab.presentation === "fields" ? tab.fields : undefined;
			const sourceLines = renderer || fields ? [] : wrapTextWithAnsi(text.replace(/\t/g, "    "), Number.MAX_SAFE_INTEGER);
			page = { sourceLines, lines: [], wrapWidth: 0, sourceLineByRow: [], firstRowBySourceLine: [], renderer, fields, viewHeight: this.viewportHeight, top: 0 };
			this.pages.set(key, page);
		}
		const width = Math.max(1, this.viewportWidth);
		if (page.wrapWidth === width) return page;
		const position = this.capturePosition(page);
		if (page.renderer) {
			// Rich renderers own their indentation/gutters; never rewrap their output.
			page.lines = page.renderer.render(width);
			page.wrapWidth = width;
			this.restorePosition(page, position);
			return page;
		}
		if (page.fields) {
			const layout = layoutDetailFields(page.fields, width, this.options.theme);
			page.lines = layout.rows;
			page.sourceLineByRow = layout.fieldByRow;
			page.firstRowBySourceLine = layout.firstRowByField;
			page.wrapWidth = width;
			this.restorePosition(page, position);
			return page;
		}
		page.lines = [];
		page.sourceLineByRow = [];
		page.firstRowBySourceLine = [];
		for (const [sourceIndex, line] of page.sourceLines.entries()) {
			page.firstRowBySourceLine.push(page.lines.length);
			for (const row of wrapDetailLine(line, width)) {
				page.lines.push(row);
				page.sourceLineByRow.push(sourceIndex);
			}
		}
		page.wrapWidth = width;
		this.restorePosition(page, position);
		return page;
	}

	private capturePosition(page: Page): { anchor?: number; offset: number; atEnd: boolean; progress: number } {
		const anchor = page.sourceLineByRow[page.top];
		const max = Math.max(0, page.lines.length - page.viewHeight);
		return {
			anchor,
			offset: (page.top - (page.firstRowBySourceLine[anchor ?? 0] ?? 0)) * page.wrapWidth,
			atEnd: max > 0 && page.top >= max,
			progress: max > 0 ? page.top / max : 0,
		};
	}

	private restorePosition(page: Page, position: ReturnType<DetailViewer["capturePosition"]>): void {
		const max = Math.max(0, page.lines.length - this.viewportHeight);
		const anchor = position.anchor;
		if (position.atEnd) page.top = max;
		else if (anchor !== undefined && page.firstRowBySourceLine[anchor] !== undefined) {
			const start = page.firstRowBySourceLine[anchor]!;
			const end = page.firstRowBySourceLine[anchor + 1] ?? page.lines.length;
			page.top = start + Math.min(Math.floor(position.offset / Math.max(1, page.wrapWidth)), Math.max(0, end - start - 1));
		} else page.top = Math.round(position.progress * max);
	}

	private clamp(): void {
		const page = this.page();
		if (page.viewHeight !== this.viewportHeight && this.capturePosition(page).atEnd) {
			page.top = Math.max(0, page.lines.length - this.viewportHeight);
		}
		page.top = Math.max(0, Math.min(page.top, Math.max(0, page.lines.length - this.viewportHeight)));
		page.viewHeight = this.viewportHeight;
	}
	private scroll(vertical: number): void {
		this.page().top += vertical;
		this.clamp();
		this.options.onRender();
	}
	private select(index: number): void {
		if (index < 0 || index >= this.model.tabs.length) return;
		this.selected = index;
		if (!this.tab().advanced) this.lastPrimary = index;
		this.clamp();
		this.options.onRender();
	}
	private primaryIndexes(): number[] {
		return this.model.tabs.flatMap((tab, index) => tab.advanced ? [] : [index]);
	}
	private cyclePrimary(direction: number): void {
		const indexes = this.primaryIndexes();
		if (!indexes.length) return;
		const position = indexes.indexOf(this.selected);
		this.select(position < 0 ? indexes[direction > 0 ? 0 : indexes.length - 1]!
			: indexes[(position + direction + indexes.length) % indexes.length]!);
	}
	private toggleMetadata(): void {
		const index = this.model.tabs.findIndex((tab) => tab.advanced);
		if (index >= 0) this.select(this.selected === index ? this.lastPrimary : index);
	}
	private toggleRaw(): void {
		if (!this.canToggleRaw()) return;
		if (this.isRaw()) this.rawTabs.delete(this.selected);
		else this.rawTabs.add(this.selected);
		this.clamp();
		this.options.onRender();
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, "escape")) { this.closed = true; this.options.onClose(); }
		else if (matchesKey(data, "tab") && this.model.showTabs) this.cyclePrimary(1);
		else if (matchesKey(data, "shift+tab") && this.model.showTabs) this.cyclePrimary(-1);
		else if (data === "m" || data === "M") this.toggleMetadata();
		else if (data === "r" || data === "R") this.toggleRaw();
		else if (matchesKey(data, "up")) this.scroll(-1);
		else if (matchesKey(data, "down")) this.scroll(1);
		else if (matchesKey(data, "pageUp")) this.scroll(-this.viewportHeight);
		else if (matchesKey(data, "pageDown")) this.scroll(this.viewportHeight);
		else if (matchesKey(data, "home")) { this.page().top = 0; this.scroll(0); }
		else if (matchesKey(data, "end")) { this.page().top = this.page().lines.length; this.scroll(0); }
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed) return undefined;
		if (event.type === "wheel") {
			const delta = event.wheelDelta ?? 0;
			if (Number.isFinite(delta)) this.scroll(Math.sign(delta) * Math.ceil(Math.abs(delta)));
			return { handled: true };
		}
		if (event.type === "click" && event.button === "left" && event.y === this.tabRow && !event.shift && !event.ctrl && !event.alt) {
			const hit = this.buttons.find((button) => event.x >= button.start && event.x < button.end);
			if (hit) { hit.action(); return { handled: true }; }
		}
		return undefined;
	}

	invalidate(): void {
		// Recreate themed JSON/Markdown/diff on demand while retaining view offsets.
		const offsets = new Map([...this.pages].map(([key, page]) => [key, this.capturePosition(page)]));
		this.pages.clear();
		const selected = this.selected;
		for (const [key, position] of offsets) {
			const [index, mode] = key.split(":");
			this.selected = Number(index);
			const wasRaw = this.rawTabs.has(this.selected);
			if (mode === "raw") this.rawTabs.add(this.selected); else this.rawTabs.delete(this.selected);
			this.restorePosition(this.page(), position);
			if (wasRaw) this.rawTabs.add(this.selected); else this.rawTabs.delete(this.selected);
		}
		this.selected = selected;
	}

	private fg(color: Parameters<Theme["fg"]>[0], text: string): string { return this.options.theme?.fg(color, text) ?? text; }

	private toolbar(width: number, xOffset: number): string {
		const right: Array<{ label: string; action: () => void; active: boolean }> = [];
		if (this.canToggleRaw() && width >= 24) right.push({ label: this.isRaw() ? "[Raw]" : "Raw", action: () => this.toggleRaw(), active: this.isRaw() });
		if (this.model.tabs.some((tab) => tab.advanced) && width >= 12) {
			right.push({ label: this.tab().advanced ? (width >= 40 ? "[Metadata]" : "[⋯]") : "⋯", action: () => this.toggleMetadata(), active: this.tab().advanced === true });
		}
		const rightWidth = right.reduce((sum, button) => sum + visibleWidth(button.label), 0) + Math.max(0, right.length - 1) * 2;
		const leftWidth = right.length ? Math.max(0, width - rightWidth - 2) : width;
		const left: string[] = [];
		let cursor = 0;
		for (const index of this.primaryIndexes()) {
			const tab = this.model.tabs[index]!;
			const label = this.selected === index ? `[${tab.label}]` : tab.label;
			const end = Math.min(leftWidth, cursor + visibleWidth(label));
			if (end > cursor) this.buttons.push({ start: cursor + xOffset, end: end + xOffset, action: () => this.select(index) });
			left.push(this.fg(this.selected === index ? "accent" : "muted", label));
			cursor += visibleWidth(label) + 2;
		}
		const notices = this.tab().truncated ? ["truncated"] : [];
		const leftText = left.join("  ") + (notices.length ? this.fg("dim", ` · ${notices.join(" · ")}`) : "");
		cursor = width - rightWidth;
		for (const button of right) {
			this.buttons.push({ start: cursor + xOffset, end: cursor + visibleWidth(button.label) + xOffset, action: button.action });
			cursor += visibleWidth(button.label) + 2;
		}
		return composeDetailLine(leftText, right.map((button) => this.fg(button.active ? "accent" : "muted", button.label)).join("  "), width);
	}

	render(width: number): string[] {
		width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		const requestedHeight = this.options.getHeight();
		const height = Number.isFinite(requestedHeight) ? Math.max(0, Math.floor(requestedHeight)) : 0;
		this.tabRow = -1; this.buttons = [];
		if (width === 0 || height === 0) return [];
		const border = width >= 4 && height >= 7;
		const inner = width - (border ? 2 : 0);
		const padding = border && inner >= 8 ? 1 : 0;
		const contentWidth = inner - padding * 2;
		const title = height >= 3;
		const tabs = this.model.showTabs && height >= 5;
		const footer = height >= 2;
		this.viewportWidth = contentWidth;
		this.viewportHeight = Math.max(1, height - Number(title) - Number(tabs) - Number(footer) - (border ? 2 : 0));
		this.clamp();
		const page = this.page();
		const row = (text: string) => {
			const content = " ".repeat(padding) + truncateToWidth(text, contentWidth, "", true) + " ".repeat(padding);
			return (border ? this.fg("border", "│") : "") + content + "\x1b[0m" + (border ? this.fg("border", "│") : "");
		};
		const output: string[] = [];
		if (border) output.push(this.fg("border", `┌${"─".repeat(inner)}┐`));
		if (title) {
			const glyph = this.model.failed ? "! Failed" : this.model.status === "success" ? "✓" : this.model.status ? "◐" : "";
			const timing = this.model.timing?.trim().split(/\s+/)[0] ?? "";
			const status = [this.fg(this.model.failed ? "error" : glyph === "✓" ? "success" : "muted", glyph), this.fg("dim", timing)].filter((part) => visibleWidth(part) > 0).join(" ");
			const label = this.model.title + (!tabs && this.model.showTabs ? ` · ${this.tab().label}${this.isRaw() ? " / Raw" : ""}` : "");
			output.push(row(composeDetailLine(this.fg("text", this.options.theme?.bold(label) ?? label), status, contentWidth)));
		}
		if (tabs) {
			this.tabRow = output.length;
			output.push(row(this.toolbar(contentWidth, Number(border) + padding)));
		}
		for (let i = 0; i < this.viewportHeight; i++) output.push(row(page.lines[page.top + i] ?? ""));
		if (footer) {
			const position = page.lines.length ? `${page.top + 1}–${Math.min(page.top + this.viewportHeight, page.lines.length)}/${page.lines.length}` : "0/0";
			const controls = contentWidth >= 64
				? `↑↓ Scroll${this.model.showTabs ? " · Tab Switch" : ""}${this.canToggleRaw() ? " · R Raw" : ""} · Esc Close`
				: contentWidth >= 32 ? `Esc${this.model.showTabs ? " · Tab" : ""}${this.canToggleRaw() ? " · R Raw" : ""} · ↑↓` : "Esc";
			output.push(row(composeDetailLine(this.fg("dim", controls), this.fg("dim", position), contentWidth)));
		}
		if (border) output.push(this.fg("border", `└${"─".repeat(inner)}┘`));
		return output;
	}
}

export async function openDetailViewer(ctx: ExtensionContext, request: DetailRequest, config?: ToolDisplayConfig): Promise<void> {
	if (!ctx.hasUI || ctx.mode !== "tui") return;
	const model = buildDetailModel(request);
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new DetailViewer(model, {
		getHeight: () => Math.max(1, Math.min(48, Math.floor(tui.terminal.rows * 0.9))),
		theme, diffConfig: config, onClose: () => done(undefined), onRender: () => tui.requestRender(),
	}), { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "100%" } });
}
