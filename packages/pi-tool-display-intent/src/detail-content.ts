import { getMarkdownTheme, highlightCode } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { DetailDiffTheme } from "./detail-diff.js";
import type { DetailField } from "./detail-viewer-model.js";

/** Coloring only: the original JSON characters and whitespace are unchanged. */
export function colorDetailJson(text: string, theme?: DetailDiffTheme): string {
	return text.replace(/("(?:\\[\s\S]|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token, string: string | undefined, keySuffix: string | undefined) => {
		if (string !== undefined) return (theme?.fg(keySuffix ? "syntaxVariable" : "syntaxString", string) ?? string) + (keySuffix ?? "");
		return theme?.fg(/^(?:true|false|null)$/.test(token) ? "syntaxKeyword" : "syntaxNumber", token) ?? token;
	});
}

export function colorDetailCode(text: string, language: string): string {
	try { return highlightCode(text, language).join("\n"); }
	catch { return text; }
}

/** ANSI-aware wrap with an explicit placeholder for an unrenderable wide grapheme. */
export function wrapDetailLine(text: string, width: number): string[] {
	const rows = wrapTextWithAnsi(text, Math.max(1, width));
	return rows.flatMap((row, index) => {
		if (row === "" && index + 1 < rows.length && visibleWidth(rows[index + 1]!) > width) return [];
		return [visibleWidth(row) > width ? "…" : row];
	});
}

export function layoutDetailFields(fields: readonly DetailField[], width: number, theme?: DetailDiffTheme): { rows: string[]; fieldByRow: number[]; firstRowByField: number[] } {
	if (width < 1 || !Number.isFinite(width)) return { rows: [], fieldByRow: [], firstRowByField: [] };
	const keyWidth = Math.min(18, Math.max(0, ...fields.map((field) => visibleWidth(field.key.replace(/\s+/g, " ")))));
	const rows: string[] = [];
	const fieldByRow: number[] = [];
	const firstRowByField: number[] = [];
	let previousBlock = false;
	for (const [fieldIndex, field] of fields.entries()) {
		const start = rows.length;
		firstRowByField.push(start);
		const key = field.key.replace(/\s+/g, " ");
		const value = field.kind === "string" && field.value === "" ? '""' : field.value;
		const scalar = !field.language && field.kind !== "json" && !value.includes("\n")
			&& visibleWidth(key) <= keyWidth && keyWidth + 2 + visibleWidth(value) <= width;
		if (rows.length > 0 && (!scalar || previousBlock)) rows.push("");
		if (scalar) {
			const label = key + " ".repeat(Math.max(0, keyWidth - visibleWidth(key)));
			const color = field.kind === "string" ? "syntaxString" : field.kind === "number" ? "syntaxNumber" : "syntaxKeyword";
			rows.push(`${theme?.fg("muted", label) ?? label}  ${theme?.fg(color, value) ?? value}`);
		} else {
			rows.push(...wrapDetailLine(theme?.fg("muted", key) ?? key, width));
			const indent = width >= 4 ? "  " : "";
			const content = field.language ? colorDetailCode(value, field.language) : field.kind === "json" ? colorDetailJson(value, theme) : value;
			for (const line of wrapTextWithAnsi(content.replace(/\t/g, "    "), Number.MAX_SAFE_INTEGER)) {
				rows.push(...wrapDetailLine(line, width - indent.length).map((row) => indent + row));
			}
		}
		for (let index = start; index < rows.length; index++) fieldByRow.push(fieldIndex);
		previousBlock = !scalar;
	}
	return { rows, fieldByRow, firstRowByField };
}

export function renderDetailFields(fields: readonly DetailField[], width: number, theme?: DetailDiffTheme): string[] {
	return layoutDetailFields(fields, width, theme).rows;
}

/** Only our Markdown component is used, never a tool-owned renderer callback. */
export function createDetailMarkdown(text: string): Pick<Component, "render"> {
	let markdown: Markdown | undefined;
	try { markdown = new Markdown(text, 0, 0, getMarkdownTheme()); } catch { /* An unbound theme falls back to source text. */ }
	return {
		render(width) {
			try {
				if (markdown) return markdown.render(width);
			} catch { /* Preserve readable source if a Markdown block cannot render. */ }
			return wrapTextWithAnsi(text, Math.max(1, width));
		},
	};
}
