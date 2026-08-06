import assert from "node:assert/strict";
import test from "node:test";
import { renderEditDiffResult, renderWriteDiffResult } from "../src/diff-renderer.ts";
import type { ToolDisplayConfig } from "../src/types.ts";

const passThroughTheme = {
	fg: (_color: string, text: string): string => text,
	bold: (text: string): string => text,
};

const summaryConfig: Partial<ToolDisplayConfig> = {
	diffViewMode: "auto",
	diffSplitMinWidth: 80,
	diffCollapsedRows: 24,
	diffCollapsedMode: "summary",
	diffWordWrap: false,
	diffIndicatorMode: "bars",
};

const bodyConfig: Partial<ToolDisplayConfig> = {
	diffViewMode: "auto",
	diffSplitMinWidth: 80,
	diffCollapsedRows: 24,
	diffCollapsedMode: "body",
	diffWordWrap: false,
	diffIndicatorMode: "bars",
};

const EDIT_DIFF = [
	"--- a/a.ts",
	"+++ b/a.ts",
	"@@ -1,2 +1,2 @@",
	"-old1",
	"-old2",
	"+new1",
	"+new2",
].join("\n");

test("renderEditDiffResult: collapsedMode=summary collapses to stats + expand hint", () => {
	const component = renderEditDiffResult(
		{ diff: EDIT_DIFF },
		{ expanded: false, filePath: "a.ts" },
		summaryConfig as any,
		passThroughTheme as any,
		"",
	);
	const lines = component.render(100);

	// Summary stats line plus a muted Ctrl+O hint line, nothing more.
	assert.equal(lines.length, 2, "collapsed summary should render exactly the stats and hint rows");
	assert.match(lines[0]!, /↳ diff \+2 -2/);
	assert.equal(lines[1], "… (Ctrl+O to expand)");
});

test("renderEditDiffResult: collapsedMode=summary still expands the full body", () => {
	const component = renderEditDiffResult(
		{ diff: EDIT_DIFF },
		{ expanded: true, filePath: "a.ts" },
		summaryConfig as any,
		passThroughTheme as any,
		"",
	);
	const lines = component.render(100);

	// Expanded must NOT collapse to the 2-line summary; it shows the real diff body.
	assert.ok(lines.length > 2, "expanded render should show the full diff body");
	assert.ok(
		lines.some((line) => line.includes("new1")),
		"expanded body should include the added line content",
	);
	assert.ok(
		!lines.some((line) => line === "… (Ctrl+O to expand)"),
		"expanded body should not show the collapse hint",
	);
});

test("renderEditDiffResult: collapsedMode=body keeps the existing collapsedRows preview", () => {
	const component = renderEditDiffResult(
		{ diff: EDIT_DIFF },
		{ expanded: false, filePath: "a.ts" },
		bodyConfig as any,
		passThroughTheme as any,
		"",
	);
	const lines = component.render(100);

	// body mode shows the real diff content (not the 2-line summary).
	assert.ok(lines.length > 2, "body mode should show the diff body, not a 2-line summary");
	assert.ok(
		lines.some((line) => line.includes("new1")),
		"body mode should include the added line content",
	);
	assert.ok(
		!lines.some((line) => line === "… (Ctrl+O to expand)"),
		"body mode should not show the forced-summary expand hint",
	);
});

test("renderWriteDiffResult: collapsedMode=summary collapses overwrite to header + stats + hint", () => {
	const component = renderWriteDiffResult(
		"new1\nnew2",
		{
			expanded: false,
			filePath: "a.ts",
			previousContent: "old1\nold2",
			fileExistedBeforeWrite: true,
		},
		summaryConfig as any,
		passThroughTheme as any,
		"",
	);
	const lines = component.render(100);

	// header + stats + hint, and the new content body must NOT be shown.
	assert.equal(lines.length, 3, "collapsed write summary should render header, stats, and hint");
	assert.match(lines[0]!, /overwritten/);
	assert.match(lines[1]!, /↳ diff \+2 -2/);
	assert.equal(lines[2], "… (Ctrl+O to expand)");
	assert.ok(
		!lines.some((line) => line.includes("new1")),
		"collapsed summary should not show the written content body",
	);
});

test("renderWriteDiffResult: collapsedMode=summary expands to the full body", () => {
	const component = renderWriteDiffResult(
		"new1\nnew2",
		{
			expanded: true,
			filePath: "a.ts",
			previousContent: "old1\nold2",
			fileExistedBeforeWrite: true,
		},
		summaryConfig as any,
		passThroughTheme as any,
		"",
	);
	const lines = component.render(100);

	assert.ok(lines.length > 3, "expanded write should show the full body, not the 3-line summary");
	assert.ok(
		lines.some((line) => line.includes("new1")),
		"expanded write body should include the written content",
	);
	assert.ok(
		!lines.some((line) => line === "… (Ctrl+O to expand)"),
		"expanded write should not show the collapse hint",
	);
});

test("renderWriteDiffResult: collapsedMode=summary with empty content shows header only", () => {
	const component = renderWriteDiffResult(
		"",
		{ expanded: false, filePath: "empty.txt", fileExistedBeforeWrite: true, previousContent: "" },
		summaryConfig as any,
		passThroughTheme as any,
		"",
	);
	const lines = component.render(100);

	// No stats line when there is no content, so no expand hint is appended either.
	assert.equal(lines.length, 1, "empty write should render the header only");
	assert.match(lines[0]!, /overwritten/);
});