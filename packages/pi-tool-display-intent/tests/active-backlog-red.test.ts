import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Box, type Component } from "@earendil-works/pi-tui";
import { renderEditDiffResult } from "../src/diff-renderer.ts";

const theme = {
	fg: (_color: string, text: string): string => text,
	bold: (text: string): string => text,
};

const diffConfig = {
	diffViewMode: "auto" as const,
	diffSplitMinWidth: 80,
	diffCollapsedRows: 24,
	diffWordWrap: false,
	diffIndicatorMode: "bars" as const,
	expandedPreviewMaxRows: 32,
};

function renderInsideToolBox(component: Component, width: number): string[] {
	const box = new Box(1, 1);
	box.addChild(component);
	return box.render(width);
}

function buildLargeUnifiedDiff(changeCount: number): string {
	const lines = [
		"--- a/large.txt",
		"+++ b/large.txt",
		`@@ -1,${changeCount} +1,${changeCount} @@`,
	];
	for (let lineNumber = 1; lineNumber <= changeCount; lineNumber++) {
		lines.push(`-old line ${lineNumber}`);
		lines.push(`+new line ${lineNumber}`);
	}
	return lines.join("\n");
}

test("issue #23: expanded large diffs stay bounded for small tmux panes", () => {
	const component = renderEditDiffResult(
		{ diff: buildLargeUnifiedDiff(80) },
		{ expanded: true, filePath: "large.txt" },
		diffConfig as any,
		theme,
		"",
	);

	const lines = renderInsideToolBox(component, 100);
	assert.ok(
		lines.length <= diffConfig.expandedPreviewMaxRows + 8,
		`expected expanded large diff to stay bounded near ${diffConfig.expandedPreviewMaxRows} lines, rendered ${lines.length}`,
	);
	assert.ok(
		lines.some((line) => /remaining|omitted|collapsed|more/i.test(line)),
		"expected a visible truncation hint for omitted large-diff content",
	);
});

test("PR #24: workspace lockfile uses patched esbuild 0.28.1", () => {
	const lockfile = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");
	assert.match(lockfile, /(?:^|\n)\s*esbuild@0\.28\.1:/);
});
