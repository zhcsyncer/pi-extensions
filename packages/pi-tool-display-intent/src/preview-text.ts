import {
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import { pluralize, sanitizeAnsiForThemedOutput } from "./render-utils.js";
import { boundDisplayLines, boundDisplayText, capFormattedRows, displayOmissionRows, DISPLAY_LIMITS, DISPLAY_OMISSION } from "./display-budget.js";
import { displayThemeSignature } from "./display-theme.js";

export const MAX_PREVIEW_LAYOUT_ROWS = 20_000;
const MAX_PREVIEW_SOURCE_CODE_UNITS = 1_000_000;
const MIN_PREVIEW_SOURCE_CODE_UNITS = 4_096;
const SOURCE_CODE_UNITS_PER_COLUMN = 16;

export interface PreviewTextTheme {
	fg(color: string, text: string): string;
}

export interface PreviewRowsLayout {
	rows: string[];
	hiddenLineCount: number;
	longLineTruncated: boolean;
	rowLimitReached: boolean;
	safetyLimitReached: boolean;
}

export interface PreviewTextOptions {
	lines: string[];
	maxRows: number;
	theme: PreviewTextTheme;
	expanded: boolean;
	outputColor?: string;
	prefix?: string;
	emptyText?: string;
	expandedRowCap?: number;
	appendHints?: (preview: string) => string;
}

function normalizeWidth(width: number): number {
	return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
}

function normalizeRowLimit(maxRows: number): number {
	if (!Number.isFinite(maxRows)) {
		return MAX_PREVIEW_LAYOUT_ROWS;
	}
	return Math.min(MAX_PREVIEW_LAYOUT_ROWS, Math.max(0, Math.floor(maxRows)));
}

function trimIncompleteSourceSuffix(text: string): string {
	let result = text;
	const finalCodeUnit = result.charCodeAt(result.length - 1);
	if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
		result = result.slice(0, -1);
	}
	return result.replace(/\x1b(?:\[[0-9;]*)?$/, "");
}

function prepareLineForLayout(
	line: string,
	width: number,
	remainingRows: number,
): { text: string; truncated: boolean; safetyLimitReached: boolean } {
	const requestedCodeUnits = Math.max(
		MIN_PREVIEW_SOURCE_CODE_UNITS,
		width * Math.max(1, remainingRows + 1) * SOURCE_CODE_UNITS_PER_COLUMN,
	);
	const sourceCodeUnitLimit = Math.min(
		MAX_PREVIEW_SOURCE_CODE_UNITS,
		requestedCodeUnits,
	);
	const sourceWasClipped = line.length > sourceCodeUnitLimit;
	const source = sourceWasClipped
		? trimIncompleteSourceSuffix(line.slice(0, sourceCodeUnitLimit))
		: line;
	const sanitized = sanitizeAnsiForThemedOutput(source);
	const visibleColumnLimit = Math.max(width, width * Math.max(1, remainingRows + 1));
	const visiblePrefix = truncateToWidth(sanitized, visibleColumnLimit, "");

	return {
		text: visiblePrefix,
		truncated: sourceWasClipped || visiblePrefix !== sanitized,
		safetyLimitReached: sourceWasClipped,
	};
}

export function layoutPreviewRows(
	lines: string[],
	maxRows: number,
	viewportWidth: number,
): PreviewRowsLayout {
	const width = Math.min(DISPLAY_LIMITS.units, normalizeWidth(viewportWidth));
	const bounded = boundDisplayLines(lines);
	lines = bounded.rows;
	const finish = (layout: PreviewRowsLayout): PreviewRowsLayout => ({
		...layout,
		hiddenLineCount: bounded.truncated ? 0 : layout.hiddenLineCount,
		safetyLimitReached: bounded.truncated || layout.safetyLimitReached,
	});
	const rowLimit = normalizeRowLimit(maxRows);
	if (rowLimit === 0) {
		return finish({
			rows: [],
			hiddenLineCount: lines.length,
			longLineTruncated: false,
			rowLimitReached: lines.length > 0,
			safetyLimitReached: false,
		});
	}

	const rows: string[] = [];
	for (const [lineIndex, line] of lines.entries()) {
		const remainingRows = rowLimit - rows.length;
		if (remainingRows <= 0) {
			return finish({
				rows,
				hiddenLineCount: lines.length - lineIndex,
				longLineTruncated: false,
				rowLimitReached: true,
				safetyLimitReached: false,
			});
		}

		const prepared = prepareLineForLayout(line, width, remainingRows);
		const wrapped = wrapTextWithAnsi(prepared.text, width);
		const shown = wrapped.slice(0, remainingRows);
		rows.push(...shown);

		const wrappedContentRemains = wrapped.length > shown.length;
		if (prepared.truncated || wrappedContentRemains) {
			return finish({
				rows,
				hiddenLineCount: Math.max(0, lines.length - lineIndex - 1),
				longLineTruncated: true,
				rowLimitReached:
					wrappedContentRemains ||
					(prepared.truncated && rows.length >= rowLimit),
				safetyLimitReached: prepared.safetyLimitReached,
			});
		}
	}

	return finish({
		rows,
		hiddenLineCount: 0,
		longLineTruncated: false,
		rowLimitReached: false,
		safetyLimitReached: false,
	});
}

function formatPreviewTruncationHint(
	layout: PreviewRowsLayout,
	expanded: boolean,
	theme: PreviewTextTheme,
): string {
	const parts: string[] = [];
	if (layout.longLineTruncated) {
		parts.push("long line truncated");
	}
	if (layout.hiddenLineCount > 0) {
		parts.push(
			`${layout.hiddenLineCount} more ${pluralize(layout.hiddenLineCount, "line")}`,
		);
	}
	if (parts.length === 0) {
		return "";
	}
	if (!expanded) {
		parts.push("Ctrl+O to expand");
	}
	return `\n${theme.fg("muted", `... (${parts.join(" • ")})`)}`;
}

// Base text, dynamic hint text and final rows share the layer's total cache budget.
const CACHE_PART_UNITS = Math.floor(DISPLAY_LIMITS.units / 3);

export class PreviewText implements Component {
	private key?: unknown[];
	private base = "";
	private hinted?: string;
	private rendered?: string[];

	constructor(private readonly options: PreviewTextOptions) {}

	private buildBase(width: number): string {
		const { lines, maxRows, theme, expanded, outputColor = "toolOutput" } = this.options;
		const layout = layoutPreviewRows(lines, maxRows, width);
		const sections: string[] = [];
		let units = 0;
		let clipped = false;
		const add = (text: string) => {
			const bounded = boundDisplayText(text, Math.max(0, CACHE_PART_UNITS - units));
			sections.push(bounded.text);
			units += bounded.text.length + 1;
			clipped ||= bounded.truncated;
		};
		if (this.options.prefix) add(this.options.prefix);
		if (layout.rows.length) {
			for (const row of layout.rows) {
				if (units >= CACHE_PART_UNITS) { clipped = true; break; }
				add(theme.fg(outputColor, row));
			}
		} else if (!layout.safetyLimitReached && lines.length === 0 && this.options.emptyText) add(this.options.emptyText);
		const hint = formatPreviewTruncationHint(layout, expanded, theme).replace(/^\n/, "");
		if (hint) add(hint);
		const expandedRowCap = Math.max(0, this.options.expandedRowCap ?? 0);
		if (expanded && expandedRowCap > 0 && layout.rowLimitReached) {
			add(theme.fg("warning", `(display capped at ${expandedRowCap} rows by tool-display setting)`));
		}
		const bounded = boundDisplayText(sections.join("\n"), CACHE_PART_UNITS);
		return bounded.text + (bounded.truncated || clipped || layout.safetyLimitReached ? `\n${DISPLAY_OMISSION}` : "");
	}

	render(width: number): string[] {
		const safeWidth = Math.min(DISPLAY_LIMITS.units, normalizeWidth(width));
		const o = this.options;
		const key = [safeWidth, o.lines, o.maxRows, o.expanded, o.outputColor, o.prefix, o.emptyText, o.expandedRowCap,
			displayThemeSignature(o.theme, [o.outputColor ?? "toolOutput", "muted", "warning"])];
		if (!this.key || key.some((value, index) => value !== this.key![index])) {
			this.base = this.buildBase(safeWidth);
			this.key = key;
			this.hinted = undefined;
			this.rendered = undefined;
		}
		// Hints can be live. Only layout/color work is cached, not arbitrary callbacks.
		const rawHinted = o.appendHints?.(this.base) ?? this.base;
		if (this.rendered && rawHinted === this.hinted) return this.rendered;
		const candidate = boundDisplayText(rawHinted, CACHE_PART_UNITS);
		const hinted = candidate.text + (candidate.truncated ? `\n${DISPLAY_OMISSION}` : "");
		if (hinted !== this.hinted || !this.rendered) {
			// Bound rows before Text pads them to the available width.
			const layoutBudget = DISPLAY_LIMITS.units - this.base.length - hinted.length;
			const maxRows = Math.max(1, Math.min(MAX_PREVIEW_LAYOUT_ROWS, Math.floor(layoutBudget / safeWidth)));
			const layout = layoutPreviewRows(hinted.split("\n", MAX_PREVIEW_LAYOUT_ROWS + 1), maxRows, safeWidth);
			const rendered = new Text(layout.rows.join("\n"), 0, 0).render(safeWidth);
			this.rendered = capFormattedRows(rendered, layoutBudget, safeWidth);
			if (layout.rowLimitReached || layout.safetyLimitReached || layout.longLineTruncated) this.rendered.push(...displayOmissionRows(safeWidth));
			this.hinted = hinted;
		}
		return this.rendered;
	}

	invalidate(): void {
		this.key = undefined;
		this.base = "";
		this.hinted = undefined;
		this.rendered = undefined;
	}
}
