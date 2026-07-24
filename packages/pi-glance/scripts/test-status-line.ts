import { strict as assert } from "node:assert";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { defaultConfig } from "../config.js";
import { stripControls } from "../format.js";
import { PALETTES, fg } from "../palette.js";
import { resolveBuiltInGlanceStyles, type GlanceRenderStyleContext } from "../theme-adapter.js";
import { GLANCE_THEME_IDS } from "../themes.js";
import { testState } from "./helpers.js";
import type { GlanceConfig, GlanceState, GlanceThemeName, SegmentId } from "../types.js";

type RenderGlanceLine = (state: GlanceState, config: GlanceConfig, width: number, providerCount?: number, styleContext?: GlanceRenderStyleContext) => string;

const RESET = "\x1b[0m";

interface StatusLineModule {
	renderGlanceLine?: unknown;
}

const statusLinePath = "../status-line.js";
const statusLine = (await import(statusLinePath)) as StatusLineModule;
const renderGlanceLine = statusLine.renderGlanceLine as RenderGlanceLine;

assert.equal(typeof statusLine.renderGlanceLine, "function", "status-line.ts should export renderGlanceLine(state, config, width, providerCount?)");

function configWithSegments(ids: SegmentId[], mutate?: (config: GlanceConfig) => void): GlanceConfig {
	const config = defaultConfig();
	config.segments = ids.map((id) => ({ id, enabled: true }));
	mutate?.(config);
	return config;
}

function useTheme(config: GlanceConfig, theme: GlanceThemeName): void {
	config.theme = { light: theme, dark: theme };
}

function plainLine(
	ids: SegmentId[],
	state: GlanceState = testState(),
	width = 120,
	providerCount = state.providers.availableCount,
	mutate?: (config: GlanceConfig) => void,
): string {
	return stripControls(renderGlanceLine(state, configWithSegments(ids, mutate), width, providerCount));
}

function rawLine(
	ids: SegmentId[],
	state: GlanceState = testState(),
	width = 120,
	providerCount = state.providers.availableCount,
	mutate?: (config: GlanceConfig) => void,
): string {
	return renderGlanceLine(state, configWithSegments(ids, mutate), width, providerCount);
}

function modelState(providerCount = 1, thinking = "off"): GlanceState {
	return testState({
		providers: { availableCount: providerCount },
		model: { id: "gpt-5.5", provider: "openai", displayName: "GPT 5.5", thinking },
	});
}

function richState(): GlanceState {
	const base = testState();
	return testState({
		git: { ...base.git, repo: true, branch: "main", status: "dirty", dirty: true, unstaged: 1 },
		providers: { availableCount: 2 },
		model: { id: "gpt-5.5", provider: "openai", displayName: "GPT 5.5", thinking: "high" },
		context: { tokens: 46_800, window: 200_000, percent: 23.4 },
		usage: { input: 12_400, output: 3_100, cacheRead: 800, cacheWrite: 20, cost: 0.042 },
	});
}

function fgSeq(color: { r: number; g: number; b: number }): string {
	return `\x1b[38;2;${color.r};${color.g};${color.b}m`;
}

function lastColorBefore(text: string, index: number): string | undefined {
	let last: string | undefined;
	const colorPattern = /\x1b\[38;2;\d+;\d+;\d+m/g;
	for (const match of text.matchAll(colorPattern)) {
		if (match.index === undefined || match.index >= index) break;
		last = match[0];
	}
	return last;
}

const singleSegmentParityCases: Array<{ id: SegmentId; state: GlanceState; text: string }> = [
	{ id: "git", state: richState(), text: "git main *" },
	{ id: "cost", state: richState(), text: "$ $0.042" },
	{ id: "throughput", state: testState(), text: "spd ? tok/s" },
	{ id: "context", state: richState(), text: "ctx 23% 47k/200k" },
	{ id: "tokens", state: richState(), text: "tok ↑12k ↓3.1k R800 W20" },
	{ id: "model", state: modelState(1), text: "ai GPT 5.5" },
];

for (const themeId of GLANCE_THEME_IDS) {
	const palette = PALETTES[themeId];
	for (const { id, state, text } of singleSegmentParityCases) {
		const config = configWithSegments([id], (next) => {
			useTheme(next, themeId);
		});
		assert.equal(
			renderGlanceLine(state, config, 120, state.providers.availableCount),
			`${fg(palette.segments[id].fg, text)}${RESET}`,
			`${themeId}.${id} status segment should keep byte-equivalent legacy palette styling through adapter`,
		);
	}
}

{
	const config = configWithSegments(["model"], (next) => {
		useTheme(next, "light");
	});
	const darkStyles = resolveBuiltInGlanceStyles("dark");
	assert.equal(
		renderGlanceLine(modelState(1), config, 120, 1, { styles: darkStyles }),
		`${fg(PALETTES.dark.segments.model.fg, "ai GPT 5.5")}${RESET}`,
		"status-line should honor an injected shared style context instead of resolving config.theme independently",
	);
}

{
	const config = configWithSegments(["model"], (next) => {
		next.theme = { light: "one-light", dark: "tokyo-night" };
	});
	assert.equal(
		renderGlanceLine(modelState(1), config, 120, 1, { ambientTone: "light" }),
		`${fg(PALETTES["one-light"].segments.model.fg, "ai GPT 5.5")}${RESET}`,
		"status-line should resolve a theme pair through the light slot for ambient light",
	);
	assert.equal(
		renderGlanceLine(modelState(1), config, 120, 1, { ambientTone: "dark" }),
		`${fg(PALETTES["tokyo-night"].segments.model.fg, "ai GPT 5.5")}${RESET}`,
		"status-line should resolve a theme pair through the dark slot for ambient dark",
	);
	assert.equal(
		renderGlanceLine(modelState(1), config, 120, 1, { ambientTone: "unknown" }),
		`${fg(PALETTES["one-light"].segments.model.fg, "ai GPT 5.5")}${RESET}`,
		"status-line should resolve a theme pair through the light slot for ambient unknown",
	);
	assert.equal(
		renderGlanceLine(modelState(1), config, 120, 1),
		`${fg(PALETTES["one-light"].segments.model.fg, "ai GPT 5.5")}${RESET}`,
		"status-line should default missing ambient tone to the light slot",
	);
	let ambientTone: "light" | "dark" = "light";
	assert.equal(
		renderGlanceLine(modelState(1), config, 120, 1, { getAmbientTone: () => ambientTone }),
		`${fg(PALETTES["one-light"].segments.model.fg, "ai GPT 5.5")}${RESET}`,
		"status-line should call getAmbientTone lazily for light output",
	);
	ambientTone = "dark";
	assert.equal(
		renderGlanceLine(modelState(1), config, 120, 1, { getAmbientTone: () => ambientTone }),
		`${fg(PALETTES["tokyo-night"].segments.model.fg, "ai GPT 5.5")}${RESET}`,
		"status-line should call getAmbientTone lazily for dark output",
	);
	const overrideStyles = resolveBuiltInGlanceStyles("dark");
	assert.equal(
		renderGlanceLine(modelState(1), config, 120, 1, { styles: overrideStyles, ambientTone: "light" }),
		`${fg(PALETTES.dark.segments.model.fg, "ai GPT 5.5")}${RESET}`,
		"status-line explicit styles override should win over ambient tone selection",
	);
}

for (const themeId of ["light", "dark", "high-contrast-light"] as const) {
	const palette = PALETTES[themeId];
	const joined = rawLine(
		["context", "model"],
		testState({ context: { tokens: 180_000, window: 200_000, percent: 90 }, model: { id: "gpt-5.5", provider: "openai", displayName: "GPT 5.5", thinking: "off" } }),
		120,
		1,
		(config) => {
			useTheme(config, themeId);
			config.context.display = "percent";
		},
	);
	assert.equal(
		joined,
		`${fg(palette.error, "ctx 90%")}${fg(palette.separator, " · ")}${fg(palette.segments.model.fg, "ai GPT 5.5")}${RESET}`,
		`${themeId} context error + separator + model join should keep byte-equivalent legacy palette styling and reset behavior`,
	);
}

for (const themeId of ["light", "dark"] as const) {
	const palette = PALETTES[themeId];
	const state = modelState(2);
	const config = configWithSegments(["model"], (next) => {
		useTheme(next, themeId);
		next.display.showProvider = "always";
	});
	const width = 12;
	const legacyLine = `${fg(palette.segments.model.fg, "ai openai/GPT 5.5")}${RESET}`;
	assert.equal(
		renderGlanceLine(state, config, width, 2),
		truncateToWidth(legacyLine, width, fg(palette.dim, "…")),
		`${themeId} truncation should keep byte-equivalent legacy dim ellipsis styling through adapter`,
	);
}

{
	const config = defaultConfig();
	config.enabled = false;
	assert.equal(renderGlanceLine(testState(), config, 120), "", "disabled config should render an empty status line");
}

{
	assert.equal(plainLine(["model"], modelState(1), 120, 1), "ai GPT 5.5", "auto provider should hide provider when only one provider is available");
	assert.equal(
		plainLine(["model"], modelState(2), 120, 2),
		"ai openai/GPT 5.5",
		"auto provider should show provider at full width when multiple providers are available",
	);
	assert.equal(plainLine(["model"], modelState(2), 80, 2), "ai GPT 5.5", "auto provider should hide provider in compact width");
	assert.equal(plainLine(["model"], modelState(2), 48, 2), "ai GPT 5.5", "auto provider should hide provider in minimal width");
	assert.equal(
		plainLine(["model"], modelState(1), 48, 1, (config) => {
			config.display.showProvider = "always";
		}),
		"ai openai/GPT 5.5",
		"provider display always should override auto width/provider-count hiding",
	);
	assert.equal(
		plainLine(["model"], modelState(3), 120, 3, (config) => {
			config.display.showProvider = "never";
		}),
		"ai GPT 5.5",
		"provider display never should hide provider even at full width with multiple providers",
	);
}

{
	const state = richState();
	const full = plainLine(["cost", "model", "context", "git"], state, 160, 2);
	assert.ok(full.indexOf("$ $0.042") < full.indexOf("ai openai/GPT 5.5 high"), "status line should follow configured segment order: cost before model");
	assert.ok(full.indexOf("ai openai/GPT 5.5 high") < full.indexOf("ctx 23% 47k/200k"), "status line should follow configured segment order: model before context");
	assert.ok(full.indexOf("ctx 23% 47k/200k") < full.indexOf("git main *"), "status line should follow configured segment order: context before git");

	const narrowWidth = 24;
	const narrow = plainLine(["model", "context", "cost", "git"], state, narrowWidth, 2);
	assert.ok(visibleWidth(narrow) <= narrowWidth, "adaptive fitting should keep visible width within the requested width");
	assert.ok(narrow.includes("ai GPT 5.5"), "adaptive fitting should keep earlier segments first");
	assert.ok(narrow.includes("ctx 23%"), "adaptive fitting should keep earlier context segment at narrow width");
	assert.equal(narrow.includes("$ $0.042"), false, "adaptive fitting should drop later cost segment before earlier segments");
	assert.equal(narrow.includes("git main"), false, "adaptive fitting should drop latest git segment first at narrow width");
}

{
	const palette = PALETTES.light;
	const normal = rawLine(
		["context"],
		testState({ context: { tokens: 140_000, window: 200_000, percent: 74 } }),
		120,
		1,
		(config) => {
			config.context.display = "percent";
		},
	);
	const warn = rawLine(
		["context"],
		testState({ context: { tokens: 150_000, window: 200_000, percent: 75 } }),
		120,
		1,
		(config) => {
			config.context.display = "percent";
		},
	);
	const error = rawLine(
		["context"],
		testState({ context: { tokens: 180_000, window: 200_000, percent: 90 } }),
		120,
		1,
		(config) => {
			config.context.display = "percent";
		},
	);
	assert.equal(lastColorBefore(normal, normal.indexOf("ctx")), fgSeq(palette.segments.context.fg), "context below warn threshold should use normal context color");
	assert.equal(lastColorBefore(warn, warn.indexOf("ctx")), fgSeq(palette.warn), "context at warn threshold should use warning color");
	assert.equal(lastColorBefore(error, error.indexOf("ctx")), fgSeq(palette.error), "context at error threshold should use error color");
	assert.equal(normal, `${fg(palette.segments.context.fg, "ctx 74%")}${RESET}`, "context below warn threshold should preserve exact normal segment ANSI bytes");
	assert.equal(warn, `${fg(palette.warn, "ctx 75%")}${RESET}`, "context at warn threshold should preserve exact warning ANSI bytes");
	assert.equal(error, `${fg(palette.error, "ctx 90%")}${RESET}`, "context at error threshold should preserve exact error ANSI bytes");

	const joined = rawLine(
		["context", "model"],
		testState({ context: { tokens: 180_000, window: 200_000, percent: 90 }, model: { id: "gpt-5.5", provider: "openai", displayName: "GPT 5.5", thinking: "off" } }),
		120,
		1,
		(config) => {
			config.context.display = "percent";
		},
	);
	assert.equal(lastColorBefore(joined, joined.indexOf(" · ")), fgSeq(palette.separator), "separator should have separator color, not context warning/error bleed");
	assert.equal(lastColorBefore(joined, joined.indexOf("ai GPT 5.5")), fgSeq(palette.segments.model.fg), "model segment should reset to model color after warning/error context");
}

{
	const state = richState();
	assert.equal(plainLine(["tokens"], state, 96), "tok ↑12k ↓3.1k R800 W20", "tokens cache auto should show cache details in full width");
	assert.equal(plainLine(["tokens"], state, 95), "tok ↑12k ↓3.1k", "tokens cache auto should hide cache details in compact width");
	assert.equal(plainLine(["tokens"], state, 63), "tok ↑12k ↓3.1k", "tokens cache auto should hide cache details in minimal width");
	assert.equal(plainLine(["model"], modelState(1, "high"), 96), "ai GPT 5.5 high", "model thinking auto should show thinking at full width");
	assert.equal(plainLine(["model"], modelState(1, "high"), 64), "ai GPT 5.5 high", "model thinking auto should show thinking at compact width");
	assert.equal(plainLine(["model"], modelState(1, "high"), 63), "ai GPT 5.5", "model thinking auto should hide thinking at minimal width");
}

for (const icons of ["plain", "nerd"] as const) {
	for (const width of [48, 80, 120]) {
		const config = configWithSegments(["git", "context", "cost", "tokens", "model"], (next) => {
			next.icons = icons;
		});
		const rendered = renderGlanceLine(richState(), config, width, 2);
		assert.ok(stripControls(rendered).length > 0, `${icons} status line should render visible text at width ${width}`);
		assert.ok(visibleWidth(rendered) <= width, `${icons} status line visible width should stay within budget ${width}`);
	}
}

console.log("✓ status line checks passed");
