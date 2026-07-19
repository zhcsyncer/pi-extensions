import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { layoutPreviewRows, PreviewText } from "../src/preview-text.ts";

const theme = {
	fg: (_color: string, text: string): string => text,
};

function renderedLines(component: PreviewText, width: number): string[] {
	return component.render(width).map((line) => line.trimEnd());
}

test("layoutPreviewRows limits a single long logical line by rendered rows", () => {
	const layout = layoutPreviewRows(["x".repeat(100)], 3, 10);

	assert.deepEqual(layout.rows, ["x".repeat(10), "x".repeat(10), "x".repeat(10)]);
	assert.equal(layout.hiddenLineCount, 0);
	assert.equal(layout.longLineTruncated, true);
	assert.equal(layout.rowLimitReached, true);
});

test("layoutPreviewRows preserves ordinary multiline previews within the row budget", () => {
	const layout = layoutPreviewRows(["alpha", "beta", "gamma"], 2, 20);

	assert.deepEqual(layout.rows, ["alpha", "beta"]);
	assert.equal(layout.hiddenLineCount, 1);
	assert.equal(layout.longLineTruncated, false);
	assert.equal(layout.rowLimitReached, true);
});

test("layoutPreviewRows measures CJK, emoji, and ANSI content by terminal width", () => {
	const layout = layoutPreviewRows(
		["\x1b[31m你好🙂世界🙂测试内容\x1b[0m"],
		3,
		6,
	);

	assert.equal(layout.rows.length, 3);
	assert.ok(layout.rows.every((row) => visibleWidth(row) <= 6));
	assert.equal(layout.longLineTruncated, true);
});

test("PreviewText reports a continued long line without claiming hidden logical lines", () => {
	const component = new PreviewText({
		lines: ["x".repeat(200)],
		maxRows: 2,
		theme,
		expanded: false,
	});
	const output = renderedLines(component, 20).join("\n");
	const contentRows = output.split("\n").filter((line) => /^x+$/.test(line));

	assert.equal(contentRows.length, 2);
	assert.match(output.replace(/\n/g, " "), /long line truncated/);
	assert.match(output.replace(/\n/g, " "), /Ctrl\+O to expand/);
	assert.doesNotMatch(output, /more lines/);
});

test("PreviewText combines long-line and hidden-line truncation details", () => {
	const component = new PreviewText({
		lines: ["x".repeat(200), "second", "third"],
		maxRows: 2,
		theme,
		expanded: false,
	});
	const output = renderedLines(component, 40).join("\n").replace(/\n/g, " ");

	assert.match(output, /long line truncated/);
	assert.match(output, /2 more lines/);
});

test("PreviewText labels an expanded visual-row cap", () => {
	const component = new PreviewText({
		lines: ["x".repeat(200)],
		maxRows: 2,
		theme,
		expanded: true,
		expandedRowCap: 2,
	});
	const output = renderedLines(component, 20).join("\n").replace(/\n/g, " ");

	assert.match(output, /long line truncated/);
	assert.match(output, /display capped at 2 rows/);
	assert.doesNotMatch(output, /Ctrl\+O/);
});

test("PreviewText bounds a very large single-line payload", () => {
	const component = new PreviewText({
		lines: ["z".repeat(100_000)],
		maxRows: 4,
		theme,
		expanded: false,
	});
	const output = renderedLines(component, 80);
	const contentRows = output.filter((line) => /^z+$/.test(line));

	assert.equal(contentRows.length, 4);
	assert.ok(contentRows.every((line) => visibleWidth(line) <= 80));
});

test("PreviewText keeps empty-output rendering explicit", () => {
	const component = new PreviewText({
		lines: [],
		maxRows: 4,
		theme,
		expanded: false,
		emptyText: "↳ (no output)",
	});

	assert.deepEqual(renderedLines(component, 40), ["↳ (no output)"]);
});
