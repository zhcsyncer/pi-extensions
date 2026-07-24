import { strict as assert } from "node:assert";
import {
	CONTEXT_DISPLAY_MODE_VALUES,
	CONTEXT_PROGRESS_STYLE_VALUES,
	CONTEXT_PROGRESS_WIDTH_VALUES,
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
import { defaultConfig } from "../config.js";
import { THROUGHPUT_PRECISION_DESCRIPTOR } from "../config-schema.js";
import {
	getSettingsCategories,
	getSettingsRows,
	getThemeCatalog,
	getThemeCatalogForSlot,
	getThemeCount,
	getThemeIdByIndex,
	getThemeIndex,
	type SettingsCategoryId,
	type SettingsRow,
} from "../settings-catalog.js";
import { GLANCE_THEMES, GLANCE_THEME_IDS } from "../themes.js";
import type { GlanceThemeSlot } from "../theme-selection.js";
import type { GlanceConfig, SegmentId } from "../types.js";

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function withTestConfig(config: GlanceConfig, mutate: (next: GlanceConfig) => void): GlanceConfig {
	const next = clone(config);
	mutate(next);
	return next;
}

function assertConfigUnchanged(before: GlanceConfig, after: GlanceConfig, message: string): void {
	assert.deepEqual(after, before, message);
}

function applyRow(config: GlanceConfig, row: SettingsRow): GlanceConfig {
	assert.ok(row.apply, `${row.label} should be editable`);
	const before = clone(config);
	const next = row.apply(config);
	assert.notEqual(next, config, `${row.label} apply should return a new config object`);
	assertConfigUnchanged(before, config, `${row.label} apply should not mutate input config`);
	return next;
}

function rowSummary(row: SettingsRow): Pick<SettingsRow, "id" | "label" | "value" | "hint" | "kind" | "opensSubview" | "themeSlot"> {
	const summary: Pick<SettingsRow, "id" | "label" | "value" | "hint" | "kind" | "opensSubview" | "themeSlot"> = {
		id: row.id,
		label: row.label,
		value: row.value,
		hint: row.hint,
		kind: row.kind,
	};
	if (row.opensSubview) summary.opensSubview = row.opensSubview;
	if (row.themeSlot) summary.themeSlot = row.themeSlot;
	return summary;
}

function assertRows(config: GlanceConfig, categoryId: SettingsCategoryId, expected: Array<Pick<SettingsRow, "id" | "label" | "value" | "hint" | "kind" | "opensSubview" | "themeSlot">>): SettingsRow[] {
	const rows = getSettingsRows(config, categoryId);
	assert.deepEqual(rows.map(rowSummary), expected, `${categoryId} rows should preserve pane copy/order/value/kind`);
	return rows;
}

function assertEditableRowsArePure(config: GlanceConfig, categoryId: SettingsCategoryId): void {
	for (const row of getSettingsRows(config, categoryId)) {
		if (!row.apply) continue;
		applyRow(config, row);
	}
}

function assertSlotCatalog(slot: GlanceThemeSlot): void {
	const ordered = getThemeCatalogForSlot(slot);
	assert.equal(ordered.length, GLANCE_THEMES.length, `${slot} slot catalog should include all themes`);
	assert.deepEqual(new Set(ordered.map((theme) => theme.id)), new Set(GLANCE_THEME_IDS), `${slot} slot catalog should include each theme exactly once`);
	const firstOtherTone = ordered.findIndex((theme) => theme.tone !== slot);
	assert.ok(firstOtherTone > 0, `${slot} slot catalog should start with preferred-tone themes`);
	assert.deepEqual(
		ordered.slice(0, firstOtherTone).map((theme) => theme.id),
		GLANCE_THEMES.filter((theme) => theme.tone === slot).map((theme) => theme.id),
		`${slot} slot catalog should preserve relative order among preferred-tone themes`,
	);
	assert.deepEqual(
		ordered.slice(firstOtherTone).map((theme) => theme.id),
		GLANCE_THEMES.filter((theme) => theme.tone !== slot).map((theme) => theme.id),
		`${slot} slot catalog should preserve relative order among remaining themes`,
	);
}

function rowById(rows: SettingsRow[], id: string): SettingsRow {
	const row = rows.find((candidate) => candidate.id === id);
	assert.ok(row, `expected row ${id}`);
	return row;
}

function assertCycleUsesValues<T extends string | number>(
	base: GlanceConfig,
	values: readonly T[],
	categoryId: SettingsCategoryId,
	rowId: string,
	label: string,
	withValue: (config: GlanceConfig, value: T) => GlanceConfig,
	getValue: (config: GlanceConfig) => T,
): void {
	for (let index = 0; index < values.length; index++) {
		const current = values[index]!;
		const expected = values[(index + 1) % values.length]!;
		const before = withValue(base, current);
		const row = rowById(getSettingsRows(before, categoryId), rowId);
		const after = applyRow(before, row);
		assert.equal(getValue(after), expected, `${label} should cycle ${current} -> ${expected}`);
	}
}

const config = defaultConfig();
const THROUGHPUT_PRECISION_VALUES = THROUGHPUT_PRECISION_DESCRIPTOR.values;
const themeCatalog = getThemeCatalog();
assert.equal(themeCatalog.length, 22, "theme catalog helper should expose the curated 22-theme collection");
assert.deepEqual(themeCatalog, GLANCE_THEMES, "theme catalog helper should return shared GLANCE_THEMES metadata exactly");
assert.equal(getThemeCount(), 22, "theme count helper should reflect the curated theme count");
assertSlotCatalog("light");
assertSlotCatalog("dark");
assert.equal(getThemeCatalogForSlot("light")[0]?.id, "light", "light slot catalog should start with the Light theme");
assert.equal(getThemeCatalogForSlot("dark")[0]?.id, "dark", "dark slot catalog should start with the Dark theme");
for (const item of themeCatalog) {
	assert.equal("palette" in item, false, `${item.id} catalog item should not expose palette data`);
}
for (const [index, themeId] of GLANCE_THEME_IDS.entries()) {
	assert.equal(getThemeIndex(themeId), index, `${themeId} index helper should match GLANCE_THEME_IDS order`);
	assert.equal(getThemeIdByIndex(index), themeId, `${themeId} id lookup should round-trip by index`);
}
assert.equal(getThemeIndex("unknown" as never), 0, "unknown theme index should safely fall back to 0");
assert.equal(getThemeIdByIndex(-1), undefined, "negative theme index should return undefined");
assert.equal(getThemeIdByIndex(GLANCE_THEME_IDS.length), undefined, "out-of-range theme index should return undefined");

const categories = getSettingsCategories(config);
assert.deepEqual(
	categories,
	[
		{ id: "general", label: "General" },
		{ id: "git", label: "Git", enabled: true },
		{ id: "cost", label: "Cost", enabled: true },
		{ id: "throughput", label: "Reply speed", enabled: true },
		{ id: "context", label: "Context", enabled: true },
		{ id: "tokens", label: "Tokens", enabled: false },
		{ id: "model", label: "Model", enabled: true },
		{ id: "details", label: "Bottom details" },
	],
	"categories should start with General then follow configured segment order with enabled flags",
);

const reordered: GlanceConfig = {
	...config,
	segments: [
		{ id: "model", enabled: false },
		{ id: "tokens", enabled: true },
		{ id: "cost", enabled: false },
		{ id: "context", enabled: true },
		{ id: "git", enabled: false },
		{ id: "throughput", enabled: true },
	],
};
assert.deepEqual(
	getSettingsCategories(reordered),
	[
		{ id: "general", label: "General" },
		{ id: "model", label: "Model", enabled: false },
		{ id: "tokens", label: "Tokens", enabled: true },
		{ id: "cost", label: "Cost", enabled: false },
		{ id: "context", label: "Context", enabled: true },
		{ id: "git", label: "Git", enabled: false },
		{ id: "throughput", label: "Reply speed", enabled: true },
		{ id: "details", label: "Bottom details" },
	],
	"categories should preserve arbitrary config.segments order",
);

const generalRows = assertRows(config, "general", [
	{
		id: "general.enabled",
		label: "Enabled",
		value: "on",
		hint: "Temporarily disable pi-glance.",
		kind: "toggle",
	},
	{
		id: "general.theme.light",
		label: "Light theme",
		value: "Light",
		hint: "Palette used for light or unknown Pi theme tone.",
		kind: "cycle",
		opensSubview: "themeBrowser",
		themeSlot: "light",
	},
	{
		id: "general.theme.dark",
		label: "Dark theme",
		value: "Dark",
		hint: "Palette used for dark Pi theme tone.",
		kind: "cycle",
		opensSubview: "themeBrowser",
		themeSlot: "dark",
	},
	{
		id: "general.icons",
		label: "Icons",
		value: "plain",
		hint: "Plain text or Nerd Font icons with fallback.",
		kind: "cycle",
	},
	{
		id: "general.minInputRows",
		label: "Min input rows",
		value: "3",
		hint: "Set the resting editor height.",
		kind: "cycle",
	},
	{
		id: "general.topMarginRows",
		label: "Top spacing",
		value: "1 row",
		hint: "Set breathing room above the editor.",
		kind: "cycle",
	},
	{
		id: "general.workspaceLabel",
		label: "Workspace label",
		value: "name",
		hint: "Show name, smart ~/ path, or safe path.",
		kind: "cycle",
	},
]);

const detailsRows = assertRows(config, "details", [
	{
		id: "bottomDetails.autoCompact",
		label: "Auto compact",
		value: "on",
		hint: "Highlight auto-compaction when Pi enables it.",
		kind: "toggle",
	},
]);

const gitRows = assertRows(config, "git", [
	{
		id: "git.enabled",
		label: "Enabled",
		value: "on",
		hint: "Show or hide this segment.",
		kind: "toggle",
	},
	{
		id: "git.dirtyMarker",
		label: "Dirty marker",
		value: "on",
		hint: "Conflicts always stay visible.",
		kind: "toggle",
	},
	{
		id: "git.aheadBehind",
		label: "Ahead / behind",
		value: "on",
		hint: "Show upstream counts.",
		kind: "toggle",
	},
	{
		id: "git.sha",
		label: "SHA",
		value: "off",
		hint: "Keep branches quiet unless enabled.",
		kind: "cycle",
	},
	{
		id: "git.polling",
		label: "Polling",
		value: "5s",
		hint: "Check external Git changes.",
		kind: "cycle",
	},
]);

const contextRows = assertRows(config, "context", [
	{
		id: "context.enabled",
		label: "Enabled",
		value: "on",
		hint: "Show or hide this segment.",
		kind: "toggle",
	},
	{
		id: "context.display",
		label: "Display",
		value: "percent / tokens",
		hint: "Choose text details or a bottom-right progress bar.",
		kind: "cycle",
	},
	{
		id: "context.progressStyle",
		label: "Progress style",
		value: "border",
		hint: "Use a standalone track or the input border itself.",
		kind: "cycle",
	},
	{
		id: "context.progressWidth",
		label: "Progress width",
		value: "one third",
		hint: "Use one third or all remaining bottom-border space.",
		kind: "cycle",
	},
	{
		id: "context.unknown",
		label: "Unknown",
		value: "show",
		hint: "Show ? or hide when context is unknown.",
		kind: "cycle",
	},
]);

const costRows = assertRows(config, "cost", [
	{
		id: "cost.enabled",
		label: "Enabled",
		value: "on",
		hint: "Show or hide this segment.",
		kind: "toggle",
	},
	{
		id: "cost.hideZero",
		label: "Hide zero",
		value: "off",
		hint: "Hide until cost is non-zero.",
		kind: "toggle",
	},
	{
		id: "cost.display",
		label: "Display",
		value: "compact USD",
		hint: "Compact session cost.",
		kind: "info",
	},
]);

const tokensRows = assertRows(config, "tokens", [
	{
		id: "tokens.enabled",
		label: "Enabled",
		value: "off",
		hint: "Show or hide this segment.",
		kind: "toggle",
	},
	{
		id: "tokens.display",
		label: "Display",
		value: "input / output",
		hint: "Choose input/output or total.",
		kind: "cycle",
	},
	{
		id: "tokens.cache",
		label: "Cache",
		value: "auto",
		hint: "Show or hide cache details.",
		kind: "cycle",
	},
]);

const modelRows = assertRows(config, "model", [
	{
		id: "model.enabled",
		label: "Enabled",
		value: "on",
		hint: "Show or hide this segment.",
		kind: "toggle",
	},
	{
		id: "model.providerLabel",
		label: "Provider label",
		value: "auto",
		hint: "Show provider name.",
		kind: "cycle",
	},
	{
		id: "model.thinkingLabel",
		label: "Thinking label",
		value: "auto",
		hint: "Show thinking level.",
		kind: "cycle",
	},
]);

const throughputRows = assertRows(config, "throughput", [
	{
		id: "throughput.enabled",
		label: "Enabled",
		value: "on",
		hint: "Show or hide this segment.",
		kind: "toggle",
	},
	{
		id: "throughput.precision",
		label: "Precision",
		value: "auto",
		hint: "Decimals for tok/s; wall time, not a benchmark.",
		kind: "cycle",
	},
]);

assert.equal(rowById(generalRows, "general.enabled").apply!(config).enabled, false, "general enabled should toggle off");
assert.equal(rowById(generalRows, "general.theme.light").opensSubview, "themeBrowser", "light theme row should declare the theme browser subview as its activation target");
assert.equal(rowById(generalRows, "general.theme.light").themeSlot, "light", "light theme row should declare its edited slot");
assert.equal(rowById(generalRows, "general.theme.dark").opensSubview, "themeBrowser", "dark theme row should declare the theme browser subview as its activation target");
assert.equal(rowById(generalRows, "general.theme.dark").themeSlot, "dark", "dark theme row should declare its edited slot");
const lightThemeApplied = rowById(generalRows, "general.theme.light").apply!(config);
assert.equal(lightThemeApplied.theme.light, getThemeCatalogForSlot("light")[1]!.id, "light theme row apply should cycle within light-preferred catalog order");
assert.equal(lightThemeApplied.theme.dark, config.theme.dark, "light theme row apply should preserve the dark slot");
const darkThemeApplied = rowById(generalRows, "general.theme.dark").apply!(config);
assert.equal(darkThemeApplied.theme.dark, getThemeCatalogForSlot("dark")[1]!.id, "dark theme row apply should cycle within dark-preferred catalog order");
assert.equal(darkThemeApplied.theme.light, config.theme.light, "dark theme row apply should preserve the light slot");
assert.equal(
	getSettingsRows({ ...config, theme: { light: "catppuccin-mocha", dark: "tokyo-night" } }, "general").find((row) => row.id === "general.theme.light")?.value,
	"Catppuccin Mocha",
	"light theme row should display friendly theme label",
);
assert.equal(
	getSettingsRows({ ...config, theme: { light: "catppuccin-mocha", dark: "tokyo-night" } }, "general").find((row) => row.id === "general.theme.dark")?.value,
	"Tokyo Night",
	"dark theme row should display friendly theme label",
);
assert.equal(rowById(generalRows, "general.icons").apply!(config).icons, "nerd", "icons should cycle plain -> nerd");
assert.equal(rowById(generalRows, "general.minInputRows").apply!(config).editor.minContentRows, 4, "min input rows should cycle 3 -> 4");
assert.equal(rowById(generalRows, "general.topMarginRows").apply!(config).editor.topMarginRows, 2, "top spacing should cycle 1 row -> 2 rows");
assert.equal(generalRows.some((row) => row.id === "general.adaptiveWidth"), false, "adaptive width should be always-on and absent from /glance");
assert.equal(rowById(generalRows, "general.workspaceLabel").apply!(config).display.workspaceLabel, "smart", "workspace label should cycle name -> smart");

assert.equal(rowById(detailsRows, "bottomDetails.autoCompact").apply!(config).bottomDetails.showAutoCompact, false, "auto compact detail should toggle off");

assert.equal(rowById(gitRows, "git.enabled").apply!(config).segments.find((segment) => segment.id === "git")?.enabled, false, "git enabled should toggle off");
assert.equal(rowById(gitRows, "git.dirtyMarker").apply!(config).git.showDirty, false, "dirty marker should toggle off");
assert.equal(rowById(gitRows, "git.aheadBehind").apply!(config).git.showAheadBehind, false, "ahead/behind should toggle off");
assert.equal(rowById(gitRows, "git.sha").apply!(config).git.shaMode, "detached", "sha mode should cycle off -> detached");
assert.equal(rowById(gitRows, "git.polling").apply!(config).git.pollIntervalMs, 10000, "polling should cycle 5s -> 10s");

const pollingValues = [2000, 5000, 10000, 30000].map((pollIntervalMs) =>
	getSettingsRows({ ...config, git: { ...config.git, pollIntervalMs } }, "git").find((row) => row.id === "git.polling")?.value,
);
assert.deepEqual(pollingValues, ["2s", "5s", "10s", "30s"], "polling values should be formatted as seconds");

assert.equal(rowById(contextRows, "context.enabled").apply!(config).segments.find((segment) => segment.id === "context")?.enabled, false, "context enabled should toggle off");
assert.equal(rowById(contextRows, "context.display").apply!(config).context.display, "percent", "context display should cycle percent+tokens -> percent");
assert.equal(rowById(contextRows, "context.progressStyle").apply!(config).context.progressStyle, "track", "context progress style should cycle border -> track");
assert.equal(rowById(contextRows, "context.progressWidth").apply!(config).context.progressWidth, "remaining", "context progress width should cycle third -> remaining");
assert.equal(rowById(contextRows, "context.unknown").apply!(config).context.unknown, "hide", "context unknown should cycle show -> hide");

assert.equal(rowById(costRows, "cost.enabled").apply!(config).segments.find((segment) => segment.id === "cost")?.enabled, false, "cost enabled should toggle off");
assert.equal(rowById(costRows, "cost.hideZero").apply!(config).cost.hideZero, true, "cost hide zero should toggle on");
const infoBefore = clone(config);
const costInfo = rowById(costRows, "cost.display");
assert.equal(costInfo.apply, undefined, "cost display info row should not expose apply");
assertConfigUnchanged(infoBefore, config, "reading an info row should not dirty config");

assert.equal(rowById(tokensRows, "tokens.enabled").apply!(config).segments.find((segment) => segment.id === "tokens")?.enabled, true, "tokens enabled should toggle on");
assert.equal(rowById(tokensRows, "tokens.display").apply!(config).tokens.display, "total", "tokens display should cycle input-output -> total");
assert.equal(rowById(tokensRows, "tokens.cache").apply!(config).tokens.cache, "show", "tokens cache should cycle auto -> show");

assert.equal(rowById(modelRows, "model.enabled").apply!(config).segments.find((segment) => segment.id === "model")?.enabled, false, "model enabled should toggle off");
assert.equal(rowById(modelRows, "model.providerLabel").apply!(config).display.showProvider, "always", "provider label should cycle auto -> always");
assert.equal(rowById(modelRows, "model.thinkingLabel").apply!(config).model.showThinking, "always", "thinking label should cycle auto -> always");
assert.equal(rowById(throughputRows, "throughput.enabled").apply!(config).segments.find((segment) => segment.id === "throughput")?.enabled, false, "throughput enabled should toggle off");
assert.equal((rowById(throughputRows, "throughput.precision").apply!(config) as unknown as { throughput: { precision: unknown } }).throughput.precision, 1, "throughput precision should cycle auto -> 1 digit");
assert.equal(rowById(throughputRows, "throughput.precision").kind, "cycle", "throughput precision should be an editable cycle row");

assertCycleUsesValues(
	config,
	ICON_MODE_VALUES,
	"general",
	"general.icons",
	"General Icons",
	(base, icons) => withTestConfig(base, (next) => {
		next.icons = icons;
	}),
	(after) => after.icons,
);
assertCycleUsesValues(
	config,
	WORKSPACE_LABEL_MODE_VALUES,
	"general",
	"general.workspaceLabel",
	"General Workspace label",
	(base, workspaceLabel) => withTestConfig(base, (next) => {
		next.display.workspaceLabel = workspaceLabel;
	}),
	(after) => after.display.workspaceLabel,
);
assertCycleUsesValues(
	config,
	EDITOR_TOP_MARGIN_ROW_VALUES,
	"general",
	"general.topMarginRows",
	"General Top spacing",
	(base, topMarginRows) => withTestConfig(base, (next) => {
		next.editor.topMarginRows = topMarginRows;
	}),
	(after) => after.editor.topMarginRows,
);
assertCycleUsesValues(
	config,
	GIT_SHA_MODE_VALUES,
	"git",
	"git.sha",
	"Git SHA",
	(base, shaMode) => withTestConfig(base, (next) => {
		next.git.shaMode = shaMode;
	}),
	(after) => after.git.shaMode,
);
assertCycleUsesValues(
	config,
	CONTEXT_DISPLAY_MODE_VALUES,
	"context",
	"context.display",
	"Context Display",
	(base, display) => withTestConfig(base, (next) => {
		next.context.display = display;
	}),
	(after) => after.context.display,
);
assertCycleUsesValues(
	config,
	CONTEXT_PROGRESS_STYLE_VALUES,
	"context",
	"context.progressStyle",
	"Context Progress Style",
	(base, progressStyle) => withTestConfig(base, (next) => {
		next.context.progressStyle = progressStyle;
	}),
	(after) => after.context.progressStyle,
);
assertCycleUsesValues(
	config,
	CONTEXT_PROGRESS_WIDTH_VALUES,
	"context",
	"context.progressWidth",
	"Context Progress Width",
	(base, progressWidth) => withTestConfig(base, (next) => {
		next.context.progressWidth = progressWidth;
	}),
	(after) => after.context.progressWidth,
);
assertCycleUsesValues(
	config,
	CONTEXT_UNKNOWN_MODE_VALUES,
	"context",
	"context.unknown",
	"Context Unknown",
	(base, unknown) => withTestConfig(base, (next) => {
		next.context.unknown = unknown;
	}),
	(after) => after.context.unknown,
);
assertCycleUsesValues(
	config,
	TOKENS_DISPLAY_MODE_VALUES,
	"tokens",
	"tokens.display",
	"Tokens Display",
	(base, display) => withTestConfig(base, (next) => {
		next.tokens.display = display;
	}),
	(after) => after.tokens.display,
);
assertCycleUsesValues(
	config,
	TOKENS_CACHE_MODE_VALUES,
	"tokens",
	"tokens.cache",
	"Tokens Cache",
	(base, cache) => withTestConfig(base, (next) => {
		next.tokens.cache = cache;
	}),
	(after) => after.tokens.cache,
);
assertCycleUsesValues(
	config,
	PROVIDER_DISPLAY_MODE_VALUES,
	"model",
	"model.providerLabel",
	"Model Provider label",
	(base, showProvider) => withTestConfig(base, (next) => {
		next.display.showProvider = showProvider;
	}),
	(after) => after.display.showProvider,
);
assertCycleUsesValues(
	config,
	MODEL_THINKING_MODE_VALUES,
	"model",
	"model.thinkingLabel",
	"Model Thinking label",
	(base, showThinking) => withTestConfig(base, (next) => {
		next.model.showThinking = showThinking;
	}),
	(after) => after.model.showThinking,
);
assertCycleUsesValues(
	config,
	THROUGHPUT_PRECISION_VALUES,
	"throughput",
	"throughput.precision",
	"Reply speed Precision",
	(base, precision) => withTestConfig(base, (next) => {
		(next as unknown as { throughput: { precision: typeof precision } }).throughput.precision = precision;
	}),
	(after) => (after as unknown as { throughput: { precision: (typeof THROUGHPUT_PRECISION_VALUES)[number] } }).throughput.precision,
);

for (const categoryId of ["general", "details", "git", "context", "cost", "tokens", "model", "throughput"] as const) {
	assertEditableRowsArePure(config, categoryId);
}

assert.deepEqual(getSettingsRows(config, "unknown" as SettingsCategoryId), [], "unknown category should safely return no rows");
assert.deepEqual(getSettingsRows(config, "git-ish" as SegmentId), [], "unknown segment id should safely return no rows");

console.log("✓ settings catalog checks passed");
