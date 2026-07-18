import assert from "node:assert/strict";
import test from "node:test";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import {
	applyToolResultStyle,
	formatClaudeToolCall,
	formatClaudeStatusMarker,
} from "../src/tool-call-style.ts";

const taggedTheme = {
	fg: (color: string, text: string): string => `<${color}>${text}</${color}>`,
	bold: (text: string): string => `<b>${text}</b>`,
};

const plainTheme = {
	fg: (_color: string, text: string): string => text,
	bold: (text: string): string => text,
};

test("Claude status markers distinguish running, success, and failure", () => {
	assert.equal(formatClaudeStatusMarker(taggedTheme, { isPartial: true }), "<warning>●</warning>");
	assert.equal(formatClaudeStatusMarker(taggedTheme, { isPartial: true }, "⠋"), "<warning>⠋</warning>");
	assert.equal(formatClaudeStatusMarker(taggedTheme, { isPartial: false }), "<success>●</success>");
	assert.equal(formatClaudeStatusMarker(taggedTheme, { isError: true }), "<error>●</error>");
});

test("Claude call headers preserve deterministic targets and intent", () => {
	const rendered = formatClaudeToolCall(
		"edit",
		"src/index.ts",
		" (2 lines)",
		" — 更新配置加载逻辑",
		plainTheme,
		{ isPartial: false },
	);
	assert.equal(rendered, "● Update(src/index.ts) (2 lines) — 更新配置加载逻辑");
});

test("Claude result wrapper replaces legacy arrows, indents continuations, and respects width", () => {
	const wrapped = applyToolResultStyle(new Text("↳ Added 1 line\ndiff detail", 0, 0), "claude") as {
		render(width: number): string[];
		invalidate(): void;
	};
	const lines = wrapped.render(24);

	assert.deepEqual(lines.map((line) => line.trimEnd()), ["  ⎿ Added 1 line", "    diff detail"]);
	assert.ok(lines.every((line) => visibleWidth(line) <= 24));
	assert.doesNotThrow(() => wrapped.invalidate());
});

test("Claude result wrapper hides empty result components and compact style is unchanged", () => {
	const empty = applyToolResultStyle(new Text("", 0, 0), "claude") as { render(width: number): string[] };
	assert.deepEqual(empty.render(80), []);

	const compact = new Text("↳ unchanged", 0, 0);
	assert.equal(applyToolResultStyle(compact, "compact"), compact);
});
