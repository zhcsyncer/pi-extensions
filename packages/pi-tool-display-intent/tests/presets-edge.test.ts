import assert from "node:assert/strict";
import test from "node:test";
import {
	applyToolDisplayPreset,
	detectToolDisplayPreset,
	getToolOutputPresetConfig,
	parseToolDisplayPreset,
	TOOL_DISPLAY_PRESETS,
	TOOL_OUTPUT_PRESET_KEYS,
	type ToolDisplayPreset,
} from "../src/presets.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";

const EXPECTED_PROFILES = {
	opencode: {
		readOutputMode: "hidden",
		searchOutputMode: "hidden",
		mcpOutputMode: "hidden",
		previewLines: 8,
		bashOutputMode: "opencode",
		bashCollapsedLines: 10,
	},
	balanced: {
		readOutputMode: "summary",
		searchOutputMode: "count",
		mcpOutputMode: "summary",
		previewLines: 8,
		bashOutputMode: "summary",
		bashCollapsedLines: 10,
	},
	verbose: {
		readOutputMode: "preview",
		searchOutputMode: "preview",
		mcpOutputMode: "preview",
		previewLines: 12,
		bashOutputMode: "preview",
		bashCollapsedLines: 20,
	},
} as const;

test("output profiles expose exactly the fields they own", () => {
	assert.deepEqual(TOOL_OUTPUT_PRESET_KEYS, [
		"readOutputMode",
		"searchOutputMode",
		"mcpOutputMode",
		"previewLines",
		"bashOutputMode",
		"bashCollapsedLines",
	]);

	for (const preset of TOOL_DISPLAY_PRESETS) {
		assert.deepEqual(getToolOutputPresetConfig(preset), EXPECTED_PROFILES[preset]);
	}
});

test("applying every output profile produces its declared values", () => {
	for (const preset of TOOL_DISPLAY_PRESETS) {
		const config = applyToolDisplayPreset(DEFAULT_TOOL_DISPLAY_CONFIG, preset);
		for (const key of TOOL_OUTPUT_PRESET_KEYS) {
			assert.equal(config[key], EXPECTED_PROFILES[preset][key], `${preset}.${key}`);
		}
		assert.equal(detectToolDisplayPreset(config), preset);
	}
});

test("applying an output profile preserves orthogonal and advanced settings", () => {
	const current: ToolDisplayConfig = {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		enabled: false,
		registerToolOverrides: {
			...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
			read: false,
			bash: false,
		},
		customToolOverrides: {
			custom_probe: { enabled: true, kind: "generic", outputMode: "preview" },
		},
		toolIntent: { enabled: false, language: "zh-CN", maxLength: 64 },
		toolCallStyle: "claude",
		enableNativeUserMessageBox: false,
		expandedPreviewMaxLines: 123,
		diffViewMode: "split",
		diffIndicatorMode: "classic",
		diffSplitMinWidth: 180,
		diffCollapsedLines: 40,
		diffWordWrap: false,
		showTruncationHints: true,
		showRtkCompactionHints: true,
	};

	const applied = applyToolDisplayPreset(current, "balanced");
	const ownedKeys = new Set<string>(TOOL_OUTPUT_PRESET_KEYS);
	for (const key of Object.keys(current) as Array<keyof ToolDisplayConfig>) {
		if (!ownedKeys.has(key)) {
			assert.deepEqual(applied[key], current[key], `preserves ${key}`);
		}
	}
	assert.equal(detectToolDisplayPreset(applied), "balanced");
});

test("orthogonal setting changes do not make a detected output profile custom", () => {
	const balanced = applyToolDisplayPreset(DEFAULT_TOOL_DISPLAY_CONFIG, "balanced");
	const variants: ToolDisplayConfig[] = [
		{ ...balanced, toolCallStyle: "claude" },
		{ ...balanced, toolIntent: { enabled: false, language: "zh-CN", maxLength: 48 } },
		{
			...balanced,
			registerToolOverrides: { ...balanced.registerToolOverrides, read: false },
		},
		{ ...balanced, diffViewMode: "split", diffWordWrap: false },
		{ ...balanced, showTruncationHints: true, showRtkCompactionHints: true },
		{ ...balanced, enableNativeUserMessageBox: false, expandedPreviewMaxLines: 99 },
	];

	for (const variant of variants) {
		assert.equal(detectToolDisplayPreset(variant), "balanced");
	}
});

test("changing any output-profile field makes detection custom", () => {
	const balanced = applyToolDisplayPreset(DEFAULT_TOOL_DISPLAY_CONFIG, "balanced");
	const variants: ToolDisplayConfig[] = [
		{ ...balanced, readOutputMode: "preview" },
		{ ...balanced, searchOutputMode: "preview" },
		{ ...balanced, mcpOutputMode: "preview" },
		{ ...balanced, previewLines: 9 },
		{ ...balanced, bashOutputMode: "preview" },
		{ ...balanced, bashCollapsedLines: 11 },
	];

	for (const variant of variants) {
		assert.equal(detectToolDisplayPreset(variant), "custom");
	}
});

test("applying a profile does not mutate the input config", () => {
	const current: ToolDisplayConfig = {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		toolCallStyle: "claude",
		toolIntent: { ...DEFAULT_TOOL_DISPLAY_CONFIG.toolIntent, language: "zh-CN" },
	};
	const snapshot = structuredClone(current);
	const applied = applyToolDisplayPreset(current, "verbose");

	assert.deepEqual(current, snapshot);
	assert.notEqual(applied, current);
	assert.equal(applied.toolIntent, current.toolIntent);
	assert.equal(applied.registerToolOverrides, current.registerToolOverrides);
});

test("parseToolDisplayPreset accepts every profile case-insensitively with whitespace", () => {
	for (const preset of TOOL_DISPLAY_PRESETS) {
		assert.equal(parseToolDisplayPreset(`  ${preset.toUpperCase()}  `), preset);
	}
});

test("parseToolDisplayPreset rejects empty, custom, and decorated names", () => {
	for (const value of ["", "   ", "custom", "turbo", "opencode!", "balanced.", "verbose-2"]) {
		assert.equal(parseToolDisplayPreset(value), undefined);
	}
});

test("profile names retain the existing command surface", () => {
	const expected: readonly ToolDisplayPreset[] = ["opencode", "balanced", "verbose"];
	assert.deepEqual(TOOL_DISPLAY_PRESETS, expected);
});
