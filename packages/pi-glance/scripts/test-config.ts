import { strict as assert } from "node:assert";
import {
	CONTEXT_DISPLAY_MODE_VALUES,
	CONTEXT_UNKNOWN_MODE_VALUES,
	EDITOR_TOP_MARGIN_ROW_VALUES,
	GIT_SHA_MODE_VALUES,
	ICON_MODE_VALUES,
	MODEL_THINKING_MODE_VALUES,
	PROVIDER_DISPLAY_MODE_VALUES,
	TOKENS_CACHE_MODE_VALUES,
	TOKENS_DISPLAY_MODE_VALUES,
	WORKSPACE_LABEL_MODE_VALUES,
} from "../config-options.js";
import { cloneConfig, configFromText, configToText, defaultConfig, normalizeConfig } from "../config.js";
import { THROUGHPUT_PRECISION_DESCRIPTOR } from "../config-schema.js";
import { GLANCE_THEME_IDS } from "../themes.js";
import type { GlanceConfig, SegmentConfig } from "../types.js";

function assertDefault(raw: unknown, message: string): void {
	assert.deepEqual(normalizeConfig(raw), defaultConfig(), message);
}

function assertSegments(actual: SegmentConfig[], expected: SegmentConfig[], message: string): void {
	assert.deepEqual(actual, expected, message);
}

const defaults = defaultConfig();
const THROUGHPUT_PRECISION_VALUES = THROUGHPUT_PRECISION_DESCRIPTOR.values;

for (const raw of [undefined, null, false, true, 0, 1, "", "{}", []]) {
	assertDefault(raw, `non-object raw config ${JSON.stringify(raw)} should normalize to defaults`);
}

assert.equal(defaults.editor.topMarginRows, 1, "default editor top margin rows should preserve the one-row breathing room");
assert.equal(defaults.version, 9, "context progress and fixed status-only footer should bump CONFIG_VERSION to 9");
assert.equal(normalizeConfig({ version: 0 }).version, 9, "old raw version should normalize to current schema version");
assert.equal(normalizeConfig({ version: 999 }).version, 9, "future raw version should normalize to current schema version");
assert.deepEqual(defaults.theme, { light: "light", dark: "dark" }, "default theme pair should use light for light tone and dark for dark tone");
assert.equal(defaults.throughput.precision, THROUGHPUT_PRECISION_DESCRIPTOR.defaultValue, "default config throughput precision should come from descriptor default");
assert.deepEqual((defaults as unknown as { throughput?: unknown }).throughput, { precision: THROUGHPUT_PRECISION_DESCRIPTOR.defaultValue }, "default config should include throughput.precision=auto");
assert.equal("footer" in defaults, false, "config should no longer expose a switch for restoring Pi informational rows");
assert.deepEqual(defaults.bottomDetails, { showAutoCompact: true }, "bottom-right details should stay enabled with auto-compaction visible by default");

for (const theme of GLANCE_THEME_IDS) {
	assert.deepEqual(normalizeConfig({ theme }).theme, { light: theme, dark: theme }, `${theme} string theme should migrate to a same/same pair`);
}

assert.deepEqual(
	normalizeConfig({ theme: { light: "catppuccin-latte", dark: "tokyo-night" } }).theme,
	{ light: "catppuccin-latte", dark: "tokyo-night" },
	"object theme pair should preserve independent valid light/dark slots",
);
assert.deepEqual(
	normalizeConfig({ theme: { light: "one-light" } }).theme,
	{ light: "one-light", dark: "dark" },
	"object theme pair should fall back only the missing dark slot",
);
assert.deepEqual(
	normalizeConfig({ theme: { dark: "nord" } }).theme,
	{ light: "light", dark: "nord" },
	"object theme pair should fall back only the missing light slot",
);
assert.deepEqual(
	normalizeConfig({ theme: { light: "dracula", dark: "catppuccin-mocha" } }).theme,
	{ light: "light", dark: "catppuccin-mocha" },
	"object theme pair should independently fall back an invalid light slot",
);
assert.deepEqual(
	normalizeConfig({ theme: { light: "solarized-light", dark: "dracula" } }).theme,
	{ light: "solarized-light", dark: "dark" },
	"object theme pair should independently fall back an invalid dark slot",
);
assert.deepEqual(normalizeConfig({ theme: "dracula" }).theme, defaults.theme, "invalid old string theme should fall back to the default pair");
assert.deepEqual(normalizeConfig({ theme: null }).theme, defaults.theme, "non-object theme should fall back to the default pair");
assert.deepEqual(normalizeConfig({}).theme, defaults.theme, "missing theme should fall back to the default pair");

{
	const source = normalizeConfig({ theme: { light: "one-light", dark: "tokyo-night" } });
	const cloned = cloneConfig(source);
	assert.deepEqual(cloned, source, "cloneConfig should preserve the theme pair");
	assert.notEqual(cloned.theme, source.theme, "cloneConfig should deep-clone the theme pair object");
	cloned.theme.light = "dark";
	assert.equal(source.theme.light, "one-light", "mutating cloned theme pair should not mutate the source config");
}

for (const icons of ICON_MODE_VALUES) {
	assert.equal(normalizeConfig({ icons }).icons, icons, `${icons} should normalize as a valid icon mode`);
}
for (const showProvider of PROVIDER_DISPLAY_MODE_VALUES) {
	assert.equal(normalizeConfig({ display: { showProvider } }).display.showProvider, showProvider, `${showProvider} should normalize as a valid provider display mode`);
}
for (const workspaceLabel of WORKSPACE_LABEL_MODE_VALUES) {
	assert.equal(normalizeConfig({ display: { workspaceLabel } }).display.workspaceLabel, workspaceLabel, `${workspaceLabel} should normalize as a valid workspace label mode`);
}
for (const topMarginRows of EDITOR_TOP_MARGIN_ROW_VALUES) {
	assert.equal(normalizeConfig({ editor: { topMarginRows } }).editor.topMarginRows, topMarginRows, `${topMarginRows} should normalize as a valid editor top margin row count`);
}
for (const shaMode of GIT_SHA_MODE_VALUES) {
	assert.equal(normalizeConfig({ git: { shaMode } }).git.shaMode, shaMode, `${shaMode} should normalize as a valid git SHA mode`);
}
for (const display of CONTEXT_DISPLAY_MODE_VALUES) {
	assert.equal(normalizeConfig({ context: { display } }).context.display, display, `${display} should normalize as a valid context display mode`);
}
for (const unknown of CONTEXT_UNKNOWN_MODE_VALUES) {
	assert.equal(normalizeConfig({ context: { unknown } }).context.unknown, unknown, `${unknown} should normalize as a valid context unknown mode`);
}
for (const display of TOKENS_DISPLAY_MODE_VALUES) {
	assert.equal(normalizeConfig({ tokens: { display } }).tokens.display, display, `${display} should normalize as a valid tokens display mode`);
}
for (const cache of TOKENS_CACHE_MODE_VALUES) {
	assert.equal(normalizeConfig({ tokens: { cache } }).tokens.cache, cache, `${cache} should normalize as a valid tokens cache mode`);
}
for (const showThinking of MODEL_THINKING_MODE_VALUES) {
	assert.equal(normalizeConfig({ model: { showThinking } }).model.showThinking, showThinking, `${showThinking} should normalize as a valid model thinking mode`);
}
for (const precision of THROUGHPUT_PRECISION_VALUES) {
	assert.equal((normalizeConfig({ throughput: { precision } }) as unknown as { throughput: { precision: unknown } }).throughput.precision, precision, `${precision} should normalize as a valid throughput precision`);
}
for (const precision of ["1", "0", "manual", 2, -1, Number.NaN, null, undefined, true, false, {}, []]) {
	assert.equal((normalizeConfig({ throughput: { precision } }) as unknown as { throughput: { precision: unknown } }).throughput.precision, THROUGHPUT_PRECISION_DESCRIPTOR.defaultValue, `${String(precision)} should fall back to descriptor default precision`);
}

const userConfig = normalizeConfig({
	version: 1,
	enabled: false,
	theme: "tokyo-night",
	icons: "nerd",
	editor: {
		minContentRows: 4,
		topMarginRows: 2,
	},
	display: {
		adaptive: false,
		showProvider: "always",
		workspaceLabel: "path",
	},
	segments: [
		{ id: "model", enabled: false },
		{ id: "tokens", enabled: true },
		{ id: "git", enabled: false },
		{ id: "cost", enabled: false },
		{ id: "context", enabled: true },
	],
	model: {
		customNames: {
			"anthropic/claude-sonnet-4-20250514": "Sonnet",
			"openai/gpt-4.1": "GPT 4.1",
		},
		showThinking: "always",
	},
	git: {
		showDirty: false,
		showAheadBehind: false,
		shaMode: "always",
		timeoutMs: 2500,
		refreshDebounceMs: 250,
		pollIntervalMs: 30000,
	},
	context: {
		display: "tokens",
		unknown: "hide",
	},
	cost: {
		hideZero: true,
	},
	tokens: {
		display: "total",
		cache: "show",
	},
	throughput: {
		precision: 1,
	},
});

assert.deepEqual(
	userConfig,
	{
		version: 9,
		enabled: false,
		theme: { light: "tokyo-night", dark: "tokyo-night" },
		icons: "nerd",
		editor: {
			minContentRows: 4,
			topMarginRows: 2,
		},
		display: {
			showProvider: "always",
			workspaceLabel: "path",
		},
		segments: [
			{ id: "model", enabled: false },
			{ id: "tokens", enabled: true },
			{ id: "git", enabled: false },
			{ id: "cost", enabled: false },
			{ id: "context", enabled: true },
			{ id: "throughput", enabled: true },
		],
		model: {
			customNames: {
				"anthropic/claude-sonnet-4-20250514": "Sonnet",
				"openai/gpt-4.1": "GPT 4.1",
			},
			showThinking: "always",
		},
		git: {
			showDirty: false,
			showAheadBehind: false,
			shaMode: "always",
			timeoutMs: 2500,
			refreshDebounceMs: 250,
			pollIntervalMs: 30000,
		},
		context: {
			display: "tokens",
			unknown: "hide",
		},
		cost: {
			hideZero: true,
		},
		tokens: {
			display: "total",
			cache: "show",
		},
		throughput: {
			precision: 1,
		},
		bottomDetails: {
			showAutoCompact: true,
		},
	},
	"valid existing user settings should be preserved while version normalizes",
);

assert.equal(normalizeConfig({ icons: "nerd" }).icons, "nerd", "saved icons: nerd should remain nerd");
const sparseConfig = normalizeConfig({ enabled: false, theme: "dark" });
assert.equal(sparseConfig.enabled, false, "missing nested groups should not reset known top-level booleans");
assert.deepEqual(sparseConfig.theme, { light: "dark", dark: "dark" }, "missing nested groups should migrate known top-level old theme strings");
assert.deepEqual(sparseConfig.editor, defaults.editor, "missing editor group should fill defaults");
assert.deepEqual(sparseConfig.display, defaults.display, "missing display group should fill defaults");
assert.deepEqual(normalizeConfig({ display: { adaptive: false } }).display, defaults.display, "legacy adaptive width setting should be ignored because fitting is always on");
assert.deepEqual(sparseConfig.model, defaults.model, "missing model group should fill defaults");
assert.deepEqual(sparseConfig.git, defaults.git, "missing git group should fill defaults");
assert.deepEqual(sparseConfig.context, defaults.context, "missing context group should fill defaults");
assert.deepEqual(sparseConfig.cost, defaults.cost, "missing cost group should fill defaults");
assert.deepEqual(sparseConfig.tokens, defaults.tokens, "missing tokens group should fill defaults");
assert.deepEqual((sparseConfig as unknown as { throughput: unknown }).throughput, { precision: "auto" }, "missing throughput group should fill defaults");
assert.deepEqual(sparseConfig.bottomDetails, defaults.bottomDetails, "missing bottom details group should fill defaults");
const migratedLegacyDetails = normalizeConfig({
	footer: { showDefaultStatus: true },
	bottomDetails: {
		enabled: false,
		showSession: false,
		showCacheHit: false,
		showSubscription: false,
		showAutoCompact: false,
		showExperimental: false,
	},
});
assert.equal("footer" in migratedLegacyDetails, false, "legacy Pi status-row switch should be dropped during normalization");
assert.deepEqual(migratedLegacyDetails.bottomDetails, { showAutoCompact: false }, "legacy detail fields and master switch should be dropped while preserving auto-compaction preference");
assert.equal(normalizeConfig({ bottomDetails: { showAutoCompact: false } }).bottomDetails.showAutoCompact, false, "auto-compaction false should be preserved");
assert.equal(normalizeConfig({ bottomDetails: { showAutoCompact: "no" } }).bottomDetails.showAutoCompact, true, "invalid auto-compaction value should fall back");

assert.deepEqual(normalizeConfig({ theme: "catppuccin-macchiato" }).theme, { light: "catppuccin-macchiato", dark: "catppuccin-macchiato" }, "curated Catppuccin Macchiato theme should normalize as valid old string migration");
assert.deepEqual(normalizeConfig({ theme: "high-contrast-light" }).theme, { light: "high-contrast-light", dark: "high-contrast-light" }, "new counterpart High Contrast Light theme should normalize as valid old string migration");
assert.deepEqual(normalizeConfig({ theme: "one-light" }).theme, { light: "one-light", dark: "one-light" }, "new counterpart One Light theme should normalize as valid old string migration");
assert.deepEqual(normalizeConfig({ theme: "kanagawa-lotus" }).theme, { light: "kanagawa-lotus", dark: "kanagawa-lotus" }, "new counterpart Kanagawa Lotus theme should normalize as valid old string migration");
assert.deepEqual(normalizeConfig({ theme: "everforest-light" }).theme, { light: "everforest-light", dark: "everforest-light" }, "new counterpart Everforest Light theme should normalize as valid old string migration");
assert.equal(normalizeConfig({ icons: "emoji" }).icons, defaults.icons, "unknown icon mode should fall back to default icons");
assert.equal(normalizeConfig({ icons: null }).icons, defaults.icons, "non-string icon mode should fall back to default icons");
assert.equal(normalizeConfig({ display: { showProvider: "sometimes" } }).display.showProvider, defaults.display.showProvider, "unknown provider mode should fall back to default");
assert.equal(normalizeConfig({ display: { workspaceLabel: "repo" } }).display.workspaceLabel, defaults.display.workspaceLabel, "unknown workspace label mode should fall back to default");
assert.equal(normalizeConfig({ git: { shaMode: "branch" } }).git.shaMode, defaults.git.shaMode, "unknown git SHA mode should fall back to default");
assert.equal(normalizeConfig({ context: { display: "window" } }).context.display, defaults.context.display, "unknown context display mode should fall back to default");
assert.equal(normalizeConfig({ context: { unknown: "dim" } }).context.unknown, defaults.context.unknown, "unknown context unknown mode should fall back to default");
assert.equal(normalizeConfig({ tokens: { display: "input" } }).tokens.display, defaults.tokens.display, "unknown tokens display mode should fall back to default");
assert.equal(normalizeConfig({ tokens: { cache: "read" } }).tokens.cache, defaults.tokens.cache, "unknown tokens cache mode should fall back to default");
assert.equal(normalizeConfig({ model: { showThinking: "maybe" } }).model.showThinking, defaults.model.showThinking, "unknown thinking mode should fall back to default");
assert.equal((normalizeConfig({ throughput: { precision: "1" } }) as unknown as { throughput: { precision: unknown } }).throughput.precision, "auto", "string throughput precision should fall back to default");
assert.equal((normalizeConfig({ throughput: { precision: 2 } }) as unknown as { throughput: { precision: unknown } }).throughput.precision, "auto", "unknown throughput precision should fall back to default");
assert.equal((normalizeConfig({ throughput: { precision: null } }) as unknown as { throughput: { precision: unknown } }).throughput.precision, "auto", "non-number/string throughput precision should fall back to default");

assert.equal(normalizeConfig({ editor: { minContentRows: 1 } }).editor.minContentRows, 2, "minContentRows should clamp to minimum 2");
assert.equal(normalizeConfig({ editor: { minContentRows: 2.9 } }).editor.minContentRows, 2, "minContentRows should floor fractional values");
assert.equal(normalizeConfig({ editor: { minContentRows: 3.9 } }).editor.minContentRows, 3, "minContentRows should floor before preserving in range");
assert.equal(normalizeConfig({ editor: { minContentRows: 9 } }).editor.minContentRows, 4, "minContentRows should clamp to maximum 4");
assert.equal(normalizeConfig({ editor: { minContentRows: Number.NaN } }).editor.minContentRows, defaults.editor.minContentRows, "NaN minContentRows should fall back to default");
assert.equal(normalizeConfig({ editor: { minContentRows: "4" } }).editor.minContentRows, defaults.editor.minContentRows, "non-number minContentRows should fall back to default");
assert.equal(normalizeConfig({ editor: {} }).editor.topMarginRows, 1, "missing topMarginRows should default to one row for old configs");
assert.equal(normalizeConfig({ editor: { topMarginRows: -1 } }).editor.topMarginRows, 0, "topMarginRows should clamp to minimum 0");
assert.equal(normalizeConfig({ editor: { topMarginRows: 99 } }).editor.topMarginRows, 2, "topMarginRows should clamp to maximum 2");
assert.equal(normalizeConfig({ editor: { topMarginRows: 1.9 } }).editor.topMarginRows, 1, "topMarginRows should floor fractional values");
assert.equal(normalizeConfig({ editor: { topMarginRows: 2.9 } }).editor.topMarginRows, 2, "topMarginRows should floor before clamping to max");
assert.equal(normalizeConfig({ editor: { topMarginRows: Number.NaN } }).editor.topMarginRows, defaults.editor.topMarginRows, "NaN topMarginRows should fall back to default");
assert.equal(normalizeConfig({ editor: { topMarginRows: null } }).editor.topMarginRows, defaults.editor.topMarginRows, "null topMarginRows should fall back to default");
assert.equal(normalizeConfig({ editor: { topMarginRows: "1" } }).editor.topMarginRows, defaults.editor.topMarginRows, "non-number topMarginRows should fall back to default");

assert.equal(normalizeConfig({ git: { timeoutMs: 99 } }).git.timeoutMs, 100, "git timeout should enforce minimum 100ms");
assert.equal(normalizeConfig({ git: { timeoutMs: 250.9 } }).git.timeoutMs, 250, "git timeout should floor fractional values");
assert.equal(normalizeConfig({ git: { timeoutMs: Number.POSITIVE_INFINITY } }).git.timeoutMs, defaults.git.timeoutMs, "non-finite git timeout should fall back to default");
assert.equal(normalizeConfig({ git: { refreshDebounceMs: -1 } }).git.refreshDebounceMs, 0, "git debounce should enforce minimum 0ms");
assert.equal(normalizeConfig({ git: { refreshDebounceMs: 250.9 } }).git.refreshDebounceMs, 250, "git debounce should floor fractional values");
assert.equal(normalizeConfig({ git: { refreshDebounceMs: "250" } }).git.refreshDebounceMs, defaults.git.refreshDebounceMs, "non-number git debounce should fall back to default");
assert.equal(normalizeConfig({ git: { pollIntervalMs: 999 } }).git.pollIntervalMs, 1000, "git polling should enforce minimum 1000ms");
assert.equal(normalizeConfig({ git: { pollIntervalMs: 1000.9 } }).git.pollIntervalMs, 1000, "git polling should floor fractional values");
assert.equal(normalizeConfig({ git: { pollIntervalMs: null } }).git.pollIntervalMs, defaults.git.pollIntervalMs, "non-number git polling should fall back to default");

assert.deepEqual(
	normalizeConfig({ model: { customNames: { sonnet: "Sonnet", empty: "", count: 4, disabled: false, nested: { name: "Nested" }, none: null } } }).model.customNames,
	{ sonnet: "Sonnet", empty: "" },
	"custom model names should preserve string values and filter non-string values",
);
assert.deepEqual(normalizeConfig({ model: { customNames: null } }).model.customNames, {}, "non-object customNames should fall back to empty object");

assertSegments(
	normalizeConfig({
		segments: [
			{ id: "tokens", enabled: true },
			{ id: "git", enabled: false },
			{ id: "model", enabled: false },
			{ id: "context", enabled: true },
			{ id: "cost", enabled: false },
		],
	}).segments,
	[
		{ id: "tokens", enabled: true },
		{ id: "git", enabled: false },
		{ id: "model", enabled: false },
		{ id: "context", enabled: true },
		{ id: "cost", enabled: false },
		{ id: "throughput", enabled: true },
	],
	"custom current segment lists should preserve known order/enabled flags and append enabled throughput",
);

assertSegments(
	normalizeConfig({
		segments: [
			{ id: "git", enabled: false },
			{ id: "tokens", enabled: true },
		],
	}).segments,
	[
		{ id: "git", enabled: false },
		{ id: "tokens", enabled: true },
		{ id: "cost", enabled: true },
		{ id: "throughput", enabled: true },
		{ id: "context", enabled: true },
		{ id: "model", enabled: true },
	],
	"segment migration should append missing default segments when current model anchor is present",
);

assertSegments(
	normalizeConfig({
		segments: [
			{ id: "git", enabled: false },
			{ id: "git", enabled: true },
			{ id: "unknown", enabled: false },
			{ id: "model", enabled: false },
			{ id: "tokens", enabled: "yes" },
		],
	}).segments,
	[
		{ id: "git", enabled: false },
		{ id: "model", enabled: false },
		{ id: "tokens", enabled: false },
		{ id: "cost", enabled: true },
		{ id: "throughput", enabled: true },
		{ id: "context", enabled: true },
	],
	"segment migration should ignore duplicates/unknown ids and use defaults for invalid enabled flags",
);

assertSegments(
	normalizeConfig({
		segments: [
			{ id: "context", enabled: false },
			{ id: "tokens", enabled: true },
		],
	}).segments,
	defaults.segments,
	"legacy/ambiguous segment lists without git should fall back to curated defaults",
);
assertSegments(normalizeConfig({ segments: [] }).segments, defaults.segments, "empty segment lists should fall back to defaults");
assertSegments(normalizeConfig({ segments: "git" }).segments, defaults.segments, "non-array segment lists should fall back to defaults");

const normalized = normalizeConfig({ enabled: false, editor: { minContentRows: 4 } });
const expectedShape: GlanceConfig = { ...defaults, enabled: false, editor: { ...defaults.editor, minContentRows: 4 } };
assert.deepEqual(normalized, expectedShape, "partial configs should normalize to the full current config shape");

const rawConfig = {
	version: 1,
	enabled: false,
	theme: "dark",
	icons: "nerd",
	display: {
		adaptive: false,
		showProvider: "never",
		workspaceLabel: "smart",
	},
	segments: [
		{ id: "git", enabled: false },
		{ id: "model", enabled: false },
	],
};
const configText = JSON.stringify(rawConfig);
const codecConfig = normalizeConfig(rawConfig);

assert.deepEqual(configFromText(configText), codecConfig, "valid config text should parse and normalize like raw config objects");
assert.throws(() => configFromText("{"), SyntaxError, "invalid JSON config text should throw instead of falling back");
assert.deepEqual(configFromText("false"), defaultConfig(), "non-object JSON config text should normalize to defaults");

const encodedText = configToText(codecConfig);
assert.equal(encodedText.endsWith("\n"), true, "configToText should end with a newline");
assert.equal(encodedText.endsWith("\n\n"), false, "configToText should end with exactly one newline");
assert.equal(encodedText.includes("\n\t\"enabled\""), true, "configToText should use tab indentation");
assert.deepEqual(JSON.parse(encodedText), normalizeConfig(codecConfig), "encoded config JSON should equal normalized config");
assert.deepEqual(configFromText(encodedText), normalizeConfig(codecConfig), "config text should round-trip through encode/decode helpers");

console.log("✓ config normalization checks passed");
