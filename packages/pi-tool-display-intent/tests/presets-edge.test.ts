import assert from "node:assert/strict";
import test from "node:test";
import {
	applyToolDisplayMode,
	detectToolDisplayMode,
	getToolResultModeConfig,
	parseToolDisplayMode,
	TOOL_RESULT_MODE_KEYS,
} from "../src/presets.ts";
import {
	DEFAULT_TOOL_DISPLAY_CONFIG,
	RESULT_DISPLAY_MODES,
	type ResultDisplayMode,
	type ToolDisplayConfig,
} from "../src/types.ts";

const EXPECTED_MODES = {
	compact: {
		readOutputMode: "hidden",
		searchOutputMode: "hidden",
		mcpOutputMode: "hidden",
		bashOutputMode: "preview",
	},
	summary: {
		readOutputMode: "summary",
		searchOutputMode: "count",
		mcpOutputMode: "summary",
		bashOutputMode: "summary",
	},
	preview: {
		readOutputMode: "preview",
		searchOutputMode: "preview",
		mcpOutputMode: "preview",
		bashOutputMode: "preview",
	},
} as const;

test("result modes expose exactly the output fields they own", () => {
	assert.deepEqual([...TOOL_RESULT_MODE_KEYS].sort(), [
		"bashOutputMode",
		"mcpOutputMode",
		"readOutputMode",
		"searchOutputMode",
	]);
	for (const mode of RESULT_DISPLAY_MODES) {
		assert.deepEqual(getToolResultModeConfig(mode), EXPECTED_MODES[mode]);
	}
});

test("applying every result mode produces its declared values", () => {
	for (const mode of RESULT_DISPLAY_MODES) {
		const config = applyToolDisplayMode(DEFAULT_TOOL_DISPLAY_CONFIG, mode);
		for (const key of TOOL_RESULT_MODE_KEYS) {
			assert.equal(config[key], EXPECTED_MODES[mode][key], `${mode}.${key}`);
		}
		assert.equal(config.resultMode, mode);
		assert.equal(detectToolDisplayMode(config), mode);
	}
});

test("applying a result mode preserves preview rows and independent settings", () => {
	const current: ToolDisplayConfig = {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		debug: true,
		previewRows: 37,
		expandedPreviewMaxRows: 777,
		toolCallStyle: "claude",
		toolIntent: { enabled: false, language: "zh-CN", maxLength: 64 },
		enableNativeUserMessageBox: false,
		enableThinkingLabel: false,
		diffViewMode: "split",
		diffIndicatorMode: "none",
		diffSplitMinWidth: 160,
		diffCollapsedRows: 48,
		diffWordWrap: false,
		showTruncationHints: true,
		showRtkCompactionHints: true,
		registerToolOverrides: {
			...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
			read: false,
		},
		customToolOverrides: {
			custom: { kind: "mcp", outputMode: "preview" },
		},
	};
	const applied = applyToolDisplayMode(current, "summary");

	assert.equal(applied.previewRows, 37);
	assert.equal(applied.debug, true);
	assert.equal(applied.expandedPreviewMaxRows, 777);
	assert.equal(applied.toolCallStyle, "claude");
	assert.deepEqual(applied.toolIntent, current.toolIntent);
	assert.equal(applied.enableNativeUserMessageBox, false);
	assert.equal(applied.enableThinkingLabel, false);
	assert.equal(applied.diffViewMode, "split");
	assert.equal(applied.diffCollapsedRows, 48);
	assert.equal(applied.showTruncationHints, true);
	assert.equal(applied.showRtkCompactionHints, true);
	assert.equal(applied.registerToolOverrides, current.registerToolOverrides);
	assert.equal(applied.customToolOverrides, current.customToolOverrides);
});

test("independent setting changes do not change detected result mode", () => {
	const summary = applyToolDisplayMode(DEFAULT_TOOL_DISPLAY_CONFIG, "summary");
	const variants: ToolDisplayConfig[] = [
		{ ...summary, debug: !summary.debug },
		{ ...summary, previewRows: summary.previewRows + 1 },
		{ ...summary, toolCallStyle: "claude" },
		{ ...summary, enableThinkingLabel: false },
		{ ...summary, diffWordWrap: false },
	];
	for (const variant of variants) {
		assert.equal(detectToolDisplayMode(variant), "summary");
	}
});

test("changing any mode-owned output field makes detection custom", () => {
	const summary = applyToolDisplayMode(DEFAULT_TOOL_DISPLAY_CONFIG, "summary");
	const variants: ToolDisplayConfig[] = [
		{ ...summary, readOutputMode: "preview" },
		{ ...summary, searchOutputMode: "preview" },
		{ ...summary, mcpOutputMode: "preview" },
		{ ...summary, bashOutputMode: "preview" },
	];
	for (const variant of variants) {
		assert.equal(detectToolDisplayMode(variant), "custom");
	}
});

test("applying a result mode does not mutate its input", () => {
	const current = {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		toolIntent: { ...DEFAULT_TOOL_DISPLAY_CONFIG.toolIntent },
		registerToolOverrides: { ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides },
	};
	const snapshot = structuredClone(current);
	const applied = applyToolDisplayMode(current, "preview");
	assert.deepEqual(current, snapshot);
	assert.notEqual(applied, current);
});

test("result mode parsing is case-insensitive and supports every final mode", () => {
	for (const mode of RESULT_DISPLAY_MODES) {
		assert.equal(parseToolDisplayMode(`  ${mode.toUpperCase()}  `), mode);
	}
	const aliases: Record<string, ResultDisplayMode> = {
		minimal: "compact",
		opencode: "compact",
		balanced: "summary",
		detailed: "preview",
		verbose: "preview",
	};
	for (const [alias, mode] of Object.entries(aliases)) {
		assert.equal(parseToolDisplayMode(alias), mode);
	}
	assert.equal(parseToolDisplayMode("custom"), undefined);
	assert.equal(parseToolDisplayMode("summary-mode"), undefined);
});
