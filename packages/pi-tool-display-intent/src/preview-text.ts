import {
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import { pluralize, sanitizeAnsiForThemedOutput } from "./render-utils.js";

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
	const width = normalizeWidth(viewportWidth);
	const rowLimit = normalizeRowLimit(maxRows);
	if (rowLimit === 0) {
		return {
			rows: [],
			hiddenLineCount: lines.length,
			longLineTruncated: false,
			rowLimitReached: lines.length > 0,
			safetyLimitReached: false,
		};
	}

	const rows: string[] = [];
	for (const [lineIndex, line] of lines.entries()) {
		const remainingRows = rowLimit - rows.length;
		if (remainingRows <= 0) {
			return {
				rows,
				hiddenLineCount: lines.length - lineIndex,
				longLineTruncated: false,
				rowLimitReached: true,
				safetyLimitReached: false,
			};
		}

		const prepared = prepareLineForLayout(line, width, remainingRows);
		const wrapped = wrapTextWithAnsi(prepared.text, width);
		const shown = wrapped.slice(0, remainingRows);
		rows.push(...shown);

		const wrappedContentRemains = wrapped.length > shown.length;
		if (prepared.truncated || wrappedContentRemains) {
			return {
				rows,
				hiddenLineCount: Math.max(0, lines.length - lineIndex - 1),
				longLineTruncated: true,
				rowLimitReached:
					wrappedContentRemains ||
					(prepared.truncated && rows.length >= rowLimit),
				safetyLimitReached: prepared.safetyLimitReached,
			};
		}
	}

	return {
		rows,
		hiddenLineCount: 0,
		longLineTruncated: false,
		rowLimitReached: false,
		safetyLimitReached: false,
	};
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

export class PreviewText implements Component {
	private renderedText?: Text;

	constructor(private readonly options: PreviewTextOptions) {}

	render(width: number): string[] {
		const safeWidth = normalizeWidth(width);
		const layout = layoutPreviewRows(
			this.options.lines,
			this.options.maxRows,
			safeWidth,
		);
		const outputColor = this.options.outputColor ?? "toolOutput";
		const sections: string[] = [];
		if (this.options.prefix) {
			sections.push(this.options.prefix);
		}

		if (layout.rows.length > 0) {
			sections.push(
				layout.rows
					.map((row) => this.options.theme.fg(outputColor, row))
					.join("\n"),
			);
		} else if (this.options.lines.length === 0 && this.options.emptyText) {
			sections.push(this.options.emptyText);
		}

		let preview = sections.join("\n");
		preview += formatPreviewTruncationHint(
			layout,
			this.options.expanded,
			this.options.theme,
		);

		const expandedRowCap = Math.max(0, this.options.expandedRowCap ?? 0);
		if (
			this.options.expanded &&
			expandedRowCap > 0 &&
			layout.rowLimitReached
		) {
			preview += `\n${this.options.theme.fg(
				"warning",
				`(display capped at ${expandedRowCap} rows by tool-display setting)`,
			)}`;
		} else if (layout.safetyLimitReached && !layout.rowLimitReached) {
			preview += `\n${this.options.theme.fg(
				"warning",
				"(display truncated by internal preview safety limit)",
			)}`;
		}

		preview = this.options.appendHints?.(preview) ?? preview;
		this.renderedText = new Text(preview, 0, 0);
		return this.renderedText.render(safeWidth);
	}

	invalidate(): void {
		this.renderedText?.invalidate();
		this.renderedText = undefined;
	}
}
