import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

function plainText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		// OSC, DCS, SOS, PM and APC strings, including their C1 forms.
		.replace(/(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
		.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*(?:[@-~]|$)/g, "")
		// Other ESC sequences (cursor save/restore, charset selection, etc.).
		.replace(/\x1b[ -/]*[0-~]/g, "")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
		.replace(/\t/g, "    ")
		// Drop only blank edge lines, not indentation on the first content line.
		.replace(/^\s*\n|\n\s*$/g, "");
}

/** Text-only rows; width already excludes the caller's frame and prefix. */
export function layoutSteerPreview(
	text: string,
	width: number,
): { rows: string[]; hiddenRows: number; omissionRow?: number } {
	if (!Number.isFinite(width) || width < 1) return { rows: [], hiddenRows: 0 };
	const columns = Math.floor(width);
	const content = plainText(text);
	if (!content.trim()) return { rows: [], hiddenRows: 0 };

	const head: string[] = [];
	const tail: string[] = [];
	let bodyRows = 0;

	// Retain at most eight head rows and two tail rows, regardless of text size.
	// Wrap one logical line at a time so multi-line input needs no full row array.
	let start = 0;
	while (start <= content.length) {
		const newline = content.indexOf("\n", start);
		const line = content.slice(start, newline < 0 ? content.length : newline);
		const wrapped = wrapTextWithAnsi(line, columns);
		for (let index = 0; index < wrapped.length; index++) {
			const row = wrapped[index]!;
			// TUI can emit an empty row before a grapheme wider than the viewport.
			if (row === "" && index + 1 < wrapped.length && visibleWidth(wrapped[index + 1]!) > columns) continue;
			// A two-cell grapheme cannot fit a one-cell viewport. Keep a visible
			// placeholder rather than breaking the grapheme or overflowing the frame.
			const fitted = visibleWidth(row) > columns ? "…" : row;
			bodyRows++;
			if (head.length < 8) head.push(fitted);
			tail.push(fitted);
			if (tail.length > 2) tail.shift();
		}
		if (newline < 0) break;
		start = newline + 1;
	}

	if (bodyRows <= 8) return { rows: head, hiddenRows: 0 };

	const hiddenRows = bodyRows - 5;
	// Every character in this fixed label occupies one cell. Slicing keeps the
	// leading ellipsis discoverable even at width 1, without adding ANSI resets.
	const omission = `… ${hiddenRows} lines hidden · click to view`.slice(0, columns);
	return {
		rows: [...head.slice(0, 3), omission, ...tail],
		hiddenRows,
		omissionRow: 3,
	};
}
