import { strict as assert } from "node:assert";
import { truncateToWidth, visibleWidth, type AutocompleteItem, type AutocompleteProvider, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "../config.js";
import { GlanceEditor } from "../editor.js";
import { PALETTES, fg } from "../palette.js";
import { createPiRenderStyleContext } from "../render-style-context.js";
import { bottomDetailsBudget, renderBottomDetails } from "../bottom-details.js";
import { renderInputSurface } from "../renderer.js";
import { resolveBuiltInGlanceStyles } from "../theme-adapter.js";
import { renderGlanceLine } from "../status-line.js";
import {
	planSurfaceBottomFrame,
	planSurfaceRow,
	planSurfaceStatusBudget,
	planSurfaceTopFrame,
	planWorkspaceTitle,
	renderSurfaceChunks,
	renderSurfaceTopMargin,
	surfaceMetrics,
} from "../surface-layout.js";
import { testState } from "./helpers.js";
import { dirtyInputSurfaceState as dirtyState, onlySegments, stripAnsi } from "./surface-test-harness.js";
import type { GlanceConfig, GlanceState, GlanceThemeName } from "../types.js";

const WIDTHS = [56, 64, 72, 96, 120, 160];

const theme = {
	borderColor: (text: string) => text,
	selectList: {
		selectedPrefix: (text: string) => text,
		selectedText: (text: string) => text,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
	},
} as unknown as EditorTheme;

function keybindingsWith(matches: Partial<Record<string, string[]>> = {}): KeybindingsManager {
	return {
		matches: (data: string, action: string) => matches[action]?.includes(data) ?? false,
	} as unknown as KeybindingsManager;
}

const keybindings = keybindingsWith();

function cleanGitState(): GlanceState {
	return testState({
		workspace: { name: "repo", path: "/repo" },
		git: {
			repo: true,
			branch: "main",
			detached: false,
			sha: "a1b2c3d",
			upstream: "origin/main",
			ahead: 0,
			behind: 0,
			staged: 0,
			unstaged: 0,
			untracked: 0,
			conflicts: 0,
			dirty: false,
			status: "clean",
			updatedAt: 0,
		},
	});
}

function noGitState(): GlanceState {
	return testState({
		workspace: { name: "repo", path: "/repo" },
		git: {
			repo: false,
			branch: null,
			detached: false,
			sha: null,
			upstream: null,
			ahead: 0,
			behind: 0,
			staged: 0,
			unstaged: 0,
			untracked: 0,
			conflicts: 0,
			dirty: false,
			status: "unknown",
			updatedAt: 0,
		},
	});
}

function makeLiveEditor(state: GlanceState, config: GlanceConfig, focused: boolean, rows = 40, bindings = keybindings): GlanceEditor {
	const editor = new GlanceEditor(
		{ terminal: { rows }, requestRender: () => undefined } as unknown as TUI,
		theme,
		bindings,
		() => state,
		() => config,
	);
	editor.focused = focused;
	return editor;
}

function ansiPiTheme(name: string, code: number) {
	return {
		name,
		getColorMode: () => "test-ansi",
		fg: (_color: string, text: string) => `\x1b[${code}m${text}\x1b[0m`,
	};
}

function topBorderIndex(lines: readonly string[]): number {
	return lines.findIndex((line) => line.startsWith("╭"));
}

function findTopBorder(lines: readonly string[]): string {
	return lines[topBorderIndex(lines)] ?? "";
}

function assertTopMargin(frame: readonly string[], rows: number, label: string, width: number): void {
	assert.equal(topBorderIndex(frame), rows, `${label} top border follows ${rows} margin rows at width ${width}`);
	for (let i = 0; i < rows; i++) {
		assert.equal(frame[i], " ", `${label} margin row ${i} is the shared top margin at width ${width}`);
		assert.equal(frame[i]?.trim(), "", `${label} margin row ${i} is blank after trim at width ${width}`);
		assert.ok(visibleWidth(frame[i] ?? "") <= width, `${label} margin row ${i} fits width ${width}`);
	}
}

function liveTop(state: GlanceState, config: GlanceConfig, width: number, focused: boolean): string {
	const editor = makeLiveEditor(state, config, focused);
	editor.setText("Ask pi to improve the input surface...");
	return findTopBorder(editor.render(width).map(stripAnsi));
}

function liveRawFrame(state: GlanceState, config: GlanceConfig, width: number, focused: boolean, text: string): string[] {
	const editor = makeLiveEditor(state, config, focused);
	editor.setText(text);
	return editor.render(width);
}

function liveFrame(state: GlanceState, config: GlanceConfig, width: number, focused: boolean, text: string): string[] {
	return liveRawFrame(state, config, width, focused, text).map(stripAnsi);
}

function rawTopBorder(lines: readonly string[]): string {
	return lines.find((line) => stripAnsi(line).startsWith("╭")) ?? "";
}

function liveBottom(state: GlanceState, config: GlanceConfig, width: number, focused: boolean): string {
	return liveFrame(state, config, width, focused, "Ask pi to improve the input surface...").at(-1) ?? "";
}

function liveScrolledBottom(state: GlanceState, config: GlanceConfig, width: number, focused: boolean): string {
	const editor = makeLiveEditor(state, config, focused, 10);
	editor.setText(Array.from({ length: 12 }, (_, index) => `line${index + 1}`).join("\n"));
	for (let i = 0; i < 20; i++) editor.handleInput("\x1b[A");
	return stripAnsi(editor.render(width).at(-1) ?? "");
}

function previewFrame(state: GlanceState, config: GlanceConfig, width: number, contentLines: string[], focused: boolean): string[] {
	return renderInputSurface(state, config, width, { contentLines, focused }).map(stripAnsi);
}

function previewTop(state: GlanceState, config: GlanceConfig, width: number): string {
	return findTopBorder(previewFrame(state, config, width, ["Ask pi to improve the input surface..."], true));
}

function previewBottom(state: GlanceState, config: GlanceConfig, width: number): string {
	return previewFrame(state, config, width, ["Ask pi to improve the input surface..."], true).at(-1) ?? "";
}

function themeName(config: GlanceConfig): GlanceThemeName {
	return config.theme.light;
}

function useTheme(config: GlanceConfig, theme: GlanceThemeName): void {
	config.theme = { light: theme, dark: theme };
}

interface LegacySurfaceOptions {
	contentLines?: string[];
	focused?: boolean;
	showTitle?: boolean;
}

function legacyBorder(config: GlanceConfig, text: string): string {
	return fg(PALETTES[themeName(config)].border, text);
}

function legacyText(config: GlanceConfig, text: string): string {
	return fg(PALETTES[themeName(config)].text, text);
}

function legacyTitle(config: GlanceConfig, text: string): string {
	return fg(PALETTES[themeName(config)].title, text);
}

function legacyDim(config: GlanceConfig, text: string): string {
	return fg(PALETTES[themeName(config)].dim, text);
}

function legacyEditorBorder(config: GlanceConfig, focused: boolean, text: string): string {
	return focused ? legacyBorder(config, text) : legacyDim(config, text);
}

function legacyEditorTitle(config: GlanceConfig, focused: boolean, text: string): string {
	return focused ? legacyTitle(config, text) : legacyDim(config, text);
}

function stripStatusForLegacyDim(status: string): string {
	return stripAnsi(status).replace(/[\r\n\t]/g, " ");
}

function renderLegacyStyledEditorTop(state: GlanceState, config: GlanceConfig, width: number, focused: boolean): string {
	const { safeWidth, innerWidth } = surfaceMetrics(width);
	const title = planWorkspaceTitle({
		workspacePath: state.workspace.path,
		workspaceName: state.workspace.name,
		mode: config.display.workspaceLabel,
		innerWidth,
		surfaceWidth: safeWidth,
	});
	const statusBudget = planSurfaceStatusBudget(innerWidth, title.width);
	const rawStatus = renderGlanceLine(state, config, statusBudget, state.providers.availableCount);
	const status = focused || !rawStatus ? rawStatus : legacyDim(config, stripStatusForLegacyDim(rawStatus));
	return renderSurfaceChunks(planSurfaceTopFrame({ width: safeWidth, left: title, status }).chunks, {
		border: (text) => legacyEditorBorder(config, focused, text),
		title: (text) => legacyEditorTitle(config, focused, text),
		status: (text) => text,
		text: (text) => text,
		dim: (text) => legacyEditorBorder(config, focused, text),
	});
}

function renderLegacyStyledEditorBottom(state: GlanceState, config: GlanceConfig, width: number, focused: boolean): string {
	const details = renderBottomDetails(state, config, bottomDetailsBudget(surfaceMetrics(width).innerWidth), {
		styles: resolveBuiltInGlanceStyles(themeName(config)),
		dimmed: !focused,
	});
	return renderSurfaceChunks(planSurfaceBottomFrame({ width, status: details }).chunks, {
		border: (text) => legacyEditorBorder(config, focused, text),
		status: (text) => text,
	});
}

function renderLegacyStyledInputSurface(state: GlanceState, config: GlanceConfig, width: number, options: LegacySurfaceOptions = {}): string[] {
	const { safeWidth, innerWidth } = surfaceMetrics(width);
	const minRows = Math.max(2, Math.min(4, config.editor.minContentRows));
	const contentLines = options.contentLines ?? [""];
	const rows = Math.max(minRows, contentLines.length);
	const title = planWorkspaceTitle({
		workspacePath: state.workspace.path,
		workspaceName: state.workspace.name,
		mode: config.display.workspaceLabel,
		innerWidth,
		surfaceWidth: safeWidth,
		showTitle: options.showTitle,
	});
	const statusBudget = planSurfaceStatusBudget(innerWidth, title.width);
	const status = renderGlanceLine(state, config, statusBudget, state.providers.availableCount);
	const top = renderSurfaceChunks(planSurfaceTopFrame({ width: safeWidth, left: title, status }).chunks, {
		border: (text) => legacyBorder(config, text),
		title: (text) => legacyTitle(config, text),
		status: (text) => text,
		text: (text) => text,
		dim: (text) => legacyDim(config, text),
	});
	const lines = [...renderSurfaceTopMargin(safeWidth, config.editor.topMarginRows), truncateToWidth(top, safeWidth, legacyBorder(config, "…"))];
	for (let i = 0; i < rows; i++) {
		const raw = contentLines[i] ?? "";
		const focusedPrefix = i === 0 && options.focused;
		const row = planSurfaceRow({
			width: safeWidth,
			text: raw,
			prefix: focusedPrefix ? "› " : "  ",
			ellipsis: legacyDim(config, "…"),
			prefixRole: focusedPrefix ? "dim" : "text",
		});
		lines.push(
			renderSurfaceChunks(row.chunks, {
				border: (text) => legacyBorder(config, text),
				content: (text) => legacyText(config, text),
				dim: (text) => legacyDim(config, text),
				text: (text) => text,
			}),
		);
	}
	const details = renderBottomDetails(state, config, bottomDetailsBudget(innerWidth), {
		styles: resolveBuiltInGlanceStyles(themeName(config)),
	});
	lines.push(
		renderSurfaceChunks(planSurfaceBottomFrame({ width: safeWidth, status: details }).chunks, {
			border: (text) => legacyBorder(config, text),
			status: (text) => text,
		}),
	);
	return lines;
}

const RENDERER_STYLE_PARITY_THEMES = ["light", "dark", "high-contrast-light"] as const satisfies readonly GlanceThemeName[];

for (const themeId of RENDERER_STYLE_PARITY_THEMES) {
	for (const width of [32, 56, 120] as const) {
		for (const focused of [true, false] as const) {
			const config = defaultConfig();
			useTheme(config, themeId);
			config.editor.topMarginRows = width === 32 ? 0 : 1;
			config.editor.minContentRows = 2;
			onlySegments(config, ["context", "model"]);
			const options = {
				contentLines: ["short", "Ask pi to improve the input surface with a long prompt that must be clipped"],
				focused,
				showTitle: width !== 32,
			};
			assert.deepEqual(
				renderInputSurface(dirtyState(), config, width, options),
				renderLegacyStyledInputSurface(dirtyState(), config, width, options),
				`${themeId} renderer adapter output should match legacy PALETTES/fg bytes at width ${width} (${focused ? "focused" : "unfocused"})`,
			);
		}
	}
}

{
	const lightConfig = defaultConfig();
	useTheme(lightConfig, "light");
	lightConfig.editor.topMarginRows = 0;
	lightConfig.editor.minContentRows = 2;
	onlySegments(lightConfig, ["model"]);
	const darkConfig = defaultConfig();
	useTheme(darkConfig, "dark");
	darkConfig.editor.topMarginRows = lightConfig.editor.topMarginRows;
	darkConfig.editor.minContentRows = lightConfig.editor.minContentRows;
	onlySegments(darkConfig, ["model"]);
	const contentLines = ["short", "Ask pi to improve the input surface with a long prompt that must be clipped"];
	assert.deepEqual(
		renderInputSurface(dirtyState(), lightConfig, 56, { contentLines, focused: true, styles: resolveBuiltInGlanceStyles("dark") }),
		renderLegacyStyledInputSurface(dirtyState(), darkConfig, 56, { contentLines, focused: true }),
		"renderer should share an injected style instance with status-line instead of letting status resolve config.theme independently",
	);
}

{
	const config = defaultConfig();
	useTheme(config, "dark");
	config.editor.topMarginRows = 0;
	config.editor.minContentRows = 2;
	onlySegments(config, []);
	const palette = PALETTES[themeName(config)];
	const frame = renderInputSurface(dirtyState(), config, 56, {
		contentLines: ["short", "Ask pi to improve the input surface with a long prompt that must be clipped"],
		focused: true,
	});
	const rendered = frame.join("\n");
	assert.ok(rendered.includes(fg(palette.border, "╭")), "renderer adapter should preserve legacy border styling bytes");
	assert.ok(rendered.includes(fg(palette.title, " 07_pi-glance ")), "renderer adapter should preserve legacy title styling bytes");
	assert.ok(rendered.includes(fg(palette.dim, "› ")), "renderer adapter should preserve legacy focused-prefix dim styling bytes");
	assert.ok(rendered.includes(fg(palette.text, "short")), "renderer adapter should preserve legacy content text styling bytes");
	assert.ok(rendered.includes(fg(palette.dim, "…")), "renderer adapter should preserve legacy dim ellipsis bytes");
}

{
	const config = defaultConfig();
	config.theme = { light: "one-light", dark: "tokyo-night" };
	config.editor.topMarginRows = 0;
	config.editor.minContentRows = 2;
	onlySegments(config, ["model"]);
	const contentLines = ["short"];
	const lightRendered = renderInputSurface(dirtyState(), config, 80, { contentLines, focused: true, ambientTone: "light" }).join("\n");
	const darkRendered = renderInputSurface(dirtyState(), config, 80, { contentLines, focused: true, ambientTone: "dark" }).join("\n");
	const unknownRendered = renderInputSurface(dirtyState(), config, 80, { contentLines, focused: true, ambientTone: "unknown" }).join("\n");
	const defaultRendered = renderInputSurface(dirtyState(), config, 80, { contentLines, focused: true }).join("\n");
	assert.ok(lightRendered.includes(fg(PALETTES["one-light"].border, "╭")), "renderer should use the light slot palette for ambient light");
	assert.ok(darkRendered.includes(fg(PALETTES["tokyo-night"].border, "╭")), "renderer should use the dark slot palette for ambient dark");
	assert.ok(unknownRendered.includes(fg(PALETTES["one-light"].border, "╭")), "renderer should use the light slot palette for ambient unknown");
	assert.ok(defaultRendered.includes(fg(PALETTES["one-light"].border, "╭")), "renderer should default missing ambient tone to the light slot palette");
}

const EDITOR_STYLE_PARITY_THEMES = ["light", "dark", "high-contrast-light"] as const satisfies readonly GlanceThemeName[];
const editorStyleState = testState({
	workspace: { name: "07_pi-glance", path: "/Users/winnie/00_project/07_pi-glance" },
	providers: { availableCount: 1 },
	model: { id: "gpt-5.5", provider: "openai", displayName: "GPT 5.5", thinking: "off" },
});

for (const themeId of EDITOR_STYLE_PARITY_THEMES) {
	for (const width of [56, 120] as const) {
		for (const focused of [true, false] as const) {
			const config = defaultConfig();
			useTheme(config, themeId);
			config.editor.topMarginRows = 0;
			config.editor.minContentRows = 2;
			onlySegments(config, ["model"]);
			const frame = liveRawFrame(editorStyleState, config, width, focused, "short");
			const top = rawTopBorder(frame);
			const bottom = frame.at(-1) ?? "";
			assert.equal(
				top,
				renderLegacyStyledEditorTop(editorStyleState, config, width, focused),
				`${themeId} live editor top border should preserve legacy PALETTES/fg bytes at width ${width} (${focused ? "focused" : "unfocused"})`,
			);
			assert.equal(
				bottom,
				renderLegacyStyledEditorBottom(editorStyleState, config, width, focused),
				`${themeId} live editor bottom border should preserve legacy PALETTES/fg bytes at width ${width} (${focused ? "focused" : "unfocused"})`,
			);
			const rendered = frame.join("\n");
			const palette = PALETTES[themeId];
			assert.ok(rendered.includes(fg(focused ? palette.border : palette.dim, "│")), `${themeId} live editor side border should keep legacy ${focused ? "border" : "dim"} bytes`);
			if (focused) {
				assert.ok(top.includes(fg(palette.title, " 07_pi-glance ")), `${themeId} focused title should keep legacy title bytes`);
				assert.ok(top.includes(fg(palette.segments.model.fg, "ai GPT 5.5")), `${themeId} focused status should keep legacy model segment bytes`);
			} else {
				assert.ok(top.includes(fg(palette.dim, " 07_pi-glance ")), `${themeId} unfocused title should keep legacy dim bytes`);
				assert.ok(top.includes(fg(palette.dim, "ai GPT 5.5")), `${themeId} unfocused status should keep legacy dim-status bytes`);
			}
		}
	}
}

{
	const state = editorStyleState;
	const config = defaultConfig();
	useTheme(config, "light");
	config.editor.topMarginRows = 0;
	onlySegments(config, ["model"]);
	const editor = makeLiveEditor(state, config, true);
	editor.setText("cache check");
	const lightTop = rawTopBorder(editor.render(120));
	assert.ok(lightTop.includes(fg(PALETTES.light.segments.model.fg, "ai GPT 5.5")), "initial live status should use light model bytes");
	useTheme(config, "dark");
	const darkTop = rawTopBorder(editor.render(120));
	assert.ok(darkTop.includes(fg(PALETTES.dark.segments.model.fg, "ai GPT 5.5")), "live status cache should invalidate when style cacheKey changes on the same config object");
	assert.equal(darkTop.includes(fg(PALETTES.light.segments.model.fg, "ai GPT 5.5")), false, "live status cache should not reuse stale light ANSI after theme/cacheKey change");
}

{
	const state = editorStyleState;
	const config = defaultConfig();
	config.theme = { light: "light", dark: "dark" };
	config.editor.topMarginRows = 0;
	onlySegments(config, ["model"]);
	let ambientTone: "light" | "dark" = "light";
	const editor = new GlanceEditor(
		{ terminal: { rows: 40 }, requestRender: () => undefined } as unknown as TUI,
		theme,
		keybindings,
		() => state,
		() => config,
		undefined,
		{ renderStyleContext: { getAmbientTone: () => ambientTone } },
	);
	editor.focused = true;
	editor.setText("cache check");
	const lightTop = rawTopBorder(editor.render(120));
	assert.ok(lightTop.includes(fg(PALETTES.light.segments.model.fg, "ai GPT 5.5")), "live editor should evaluate getAmbientTone during render for light status bytes");
	ambientTone = "dark";
	const darkTop = rawTopBorder(editor.render(120));
	assert.ok(darkTop.includes(fg(PALETTES.dark.segments.model.fg, "ai GPT 5.5")), "live editor should re-evaluate getAmbientTone on later renders and invalidate cache by style cacheKey");
	assert.equal(darkTop.includes(fg(PALETTES.light.segments.model.fg, "ai GPT 5.5")), false, "live editor should not reuse stale light status bytes after ambient tone changes");
}

{
	const state = editorStyleState;
	const config = defaultConfig();
	useTheme(config, "light");
	config.editor.topMarginRows = 0;
	onlySegments(config, ["model"]);
	const firstContext = createPiRenderStyleContext(ansiPiTheme("editor-pi-a", 31));
	const secondContext = createPiRenderStyleContext(ansiPiTheme("editor-pi-b", 32));
	assert.ok(firstContext?.styles && secondContext?.styles, "test Pi render style contexts should resolve");
	const renderStyleContext = { styles: firstContext.styles };
	const editor = new GlanceEditor(
		{ terminal: { rows: 40 }, requestRender: () => undefined } as unknown as TUI,
		theme,
		keybindings,
		() => state,
		() => config,
		undefined,
		{ renderStyleContext },
	);
	editor.focused = true;
	editor.setText("cache check");
	const firstTop = rawTopBorder(editor.render(120));
	assert.ok(firstTop.includes("\x1b[31mai GPT 5.5\x1b[0m"), "injected Pi editor style context should style live status through the context");
	renderStyleContext.styles = secondContext.styles;
	const secondTop = rawTopBorder(editor.render(120));
	assert.ok(secondTop.includes("\x1b[32mai GPT 5.5\x1b[0m"), "live status cache should invalidate when injected style cacheKey changes");
	assert.equal(secondTop.includes("\x1b[31mai GPT 5.5\x1b[0m"), false, "live status cache should not reuse stale injected Pi ANSI after context cacheKey change");
}

interface Scenario {
	name: string;
	state: GlanceState;
	configure?: (config: GlanceConfig) => void;
}

const scenarios: Scenario[] = [
	{
		name: "default dirty plain provider2 long model",
		state: dirtyState(),
	},
	{
		name: "clean git branch-only quiet status",
		state: cleanGitState(),
		configure: (config) => onlySegments(config, ["git"]),
	},
	{
		name: "no git repo hidden empty status",
		state: noGitState(),
		configure: (config) => onlySegments(config, ["git"]),
	},
	{
		name: "workspace label smart",
		state: dirtyState(),
		configure: (config) => {
			config.display.workspaceLabel = "smart";
		},
	},
	{
		name: "workspace label path",
		state: dirtyState(),
		configure: (config) => {
			config.display.workspaceLabel = "path";
		},
	},
	{
		name: "nerd icons",
		state: dirtyState(),
		configure: (config) => {
			config.icons = "nerd";
		},
	},
];

for (const scenario of scenarios) {
	for (const width of WIDTHS) {
		const config = defaultConfig();
		scenario.configure?.(config);
		const preview = previewFrame(scenario.state, config, width, ["Ask pi to improve the input surface..."], true);
		assertTopMargin(preview, config.editor.topMarginRows, `${scenario.name} preview`, width);
		const expectedTop = findTopBorder(preview);
		const expectedBottom = previewBottom(scenario.state, config, width);
		assert.ok(expectedTop.startsWith("╭"), `${scenario.name} preview top border should follow the margin at width ${width}`);
		assert.ok(visibleWidth(expectedTop) <= width, `${scenario.name} preview top should fit width ${width}`);
		assert.ok(visibleWidth(expectedBottom) <= width, `${scenario.name} preview bottom should fit width ${width}`);
		for (const focused of [true, false]) {
			const live = liveFrame(scenario.state, config, width, focused, "Ask pi to improve the input surface...");
			assertTopMargin(live, config.editor.topMarginRows, `${scenario.name} live ${focused ? "focused" : "unfocused"}`, width);
			const actualTop = liveTop(scenario.state, config, width, focused);
			assert.equal(
				actualTop,
				expectedTop,
				`${scenario.name} live top should match preview at width ${width} when ${focused ? "focused" : "unfocused"}`,
			);
			assert.ok(visibleWidth(actualTop) <= width, `${scenario.name} live top should fit width ${width}`);

			const actualBottom = liveBottom(scenario.state, config, width, focused);
			assert.equal(
				actualBottom,
				expectedBottom,
				`${scenario.name} live bottom should match preview at width ${width} when ${focused ? "focused" : "unfocused"}`,
			);
			assert.ok(visibleWidth(actualBottom) <= width, `${scenario.name} live bottom should fit width ${width}`);
		}
	}
}

for (const width of WIDTHS) {
	const config = defaultConfig();
	const scrolledBottom = liveScrolledBottom(dirtyState(), config, width, true);
	assert.ok(scrolledBottom.includes("↓"), `live bottom should show a down scroll indicator at width ${width}`);
	assert.ok(scrolledBottom.includes("more"), `live bottom should include scroll count copy at width ${width}`);
	assert.ok(visibleWidth(scrolledBottom) <= width, `live scrolled bottom should fit width ${width}`);
}

{
	const config = defaultConfig();
	config.editor.topMarginRows = 0;
	config.editor.minContentRows = 2;
	const editor = makeLiveEditor(dirtyState(), config, true, 40, keybindingsWith({ "tui.input.newLine": ["\u000a"] }));
	let thinkingNotifications = 0;
	const thinkingEditor = new GlanceEditor(
		{ terminal: { rows: 40 }, requestRender: () => undefined } as unknown as TUI,
		theme,
		keybindingsWith({ "app.thinking.cycle": ["t"] }),
		() => dirtyState(),
		() => config,
		() => {
			thinkingNotifications++;
		},
	);
	thinkingEditor.handleInput("t");
	assert.equal(thinkingNotifications, 1, "GlanceEditor should invoke the thinking-cycle callback exactly once for the matching key");
	assert.equal(thinkingEditor.getText(), "t", "thinking-cycle input should still delegate through CustomEditor to Pi editor text handling");
	thinkingEditor.handleInput("x");
	assert.equal(thinkingNotifications, 1, "non-thinking input should not trigger the thinking-cycle callback");
	assert.equal(thinkingEditor.getText(), "tx", "non-thinking printable input should continue to use inherited Pi editor handling");

	editor.setText("中文🙂wide");
	editor.handleInput("\u000a");
	editor.handleInput("下一行");
	assert.equal(editor.getText(), "中文🙂wide\n下一行", "Ctrl+J/newline should delegate to Pi editor input behavior");
	const frame = editor.render(48).map(stripAnsi);
	assert.ok(frame.some((line) => line.includes("中文🙂wide")), "wide CJK/emoji content should render inside GlanceEditor frame");
	assert.ok(frame.some((line) => line.includes("下一行")), "unicode line after Ctrl+J should render inside GlanceEditor frame");
	for (const line of frame) {
		assert.ok(visibleWidth(line) <= 48, `unicode editor frame line should fit width 48: ${line}`);
	}
}

{
	const config = defaultConfig();
	const interruptEditor = makeLiveEditor(dirtyState(), config, true, 40, keybindingsWith({ "app.interrupt": ["\u001b"] }));
	let interrupts = 0;
	interruptEditor.onEscape = () => {
		interrupts++;
	};
	interruptEditor.setText("keep editing");
	interruptEditor.handleInput("\u001b");
	assert.equal(interrupts, 1, "GlanceEditor should delegate app.interrupt to CustomEditor onEscape exactly once");
	assert.equal(interruptEditor.getText(), "keep editing", "app.interrupt should be handled by CustomEditor without mutating editor text");

	const editorKeyEditor = makeLiveEditor(dirtyState(), config, true);
	editorKeyEditor.handleInput("abc");
	editorKeyEditor.handleInput("\u001b[D");
	assert.deepEqual(editorKeyEditor.getCursor(), { line: 0, col: 2 }, "left-arrow editor keybinding should move the inherited Pi editor cursor");
	editorKeyEditor.handleInput("\u007f");
	assert.equal(editorKeyEditor.getText(), "ac", "backspace editor keybinding should delete through inherited Pi editor behavior");
}

{
	const config = defaultConfig();
	config.editor.topMarginRows = 0;
	const editor = makeLiveEditor(dirtyState(), config, true, 40, keybindingsWith({ "tui.input.tab": ["\t"] }));
	const completion: AutocompleteItem = { value: "src/中文-file.ts", label: "src/中文-file.ts", description: "wide path" };
	const provider: AutocompleteProvider = {
		getSuggestions: async () => ({ prefix: "src", items: [completion, { value: "src/other.ts", label: "src/other.ts" }] }),
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
			const line = lines[cursorLine] ?? "";
			const start = Math.max(0, cursorCol - prefix.length);
			return {
				lines: [...lines.slice(0, cursorLine), `${line.slice(0, start)}${item.value}${line.slice(cursorCol)}`, ...lines.slice(cursorLine + 1)],
				cursorLine,
				cursorCol: start + item.value.length,
			};
		},
		shouldTriggerFileCompletion: () => true,
	};
	editor.setAutocompleteProvider(provider);
	editor.setText("src");
	editor.handleInput("\t");
	await Promise.resolve();
	await Promise.resolve();
	const autocompleteFrame = editor.render(80).map(stripAnsi);
	const autocompleteLine = autocompleteFrame.find((line) => line.includes("src/中文-file.ts"));
	assert.ok(autocompleteLine, "autocomplete suggestions with CJK text should render below GlanceEditor frame");
	assert.ok(autocompleteLine?.startsWith("  "), "autocomplete lines should keep pi-glance indentation outside the framed editor");
	for (const line of autocompleteFrame) {
		assert.ok(visibleWidth(line) <= 80, `autocomplete editor frame line should fit width 80: ${line}`);
	}
}

for (const topMarginRows of [0, 1, 2] as const) {
	for (const minContentRows of [2, 3, 4]) {
		for (const width of WIDTHS) {
			const config = defaultConfig();
			config.editor.minContentRows = minContentRows;
			config.editor.topMarginRows = topMarginRows;
			const shortText = "short row";
			const longText = "Ask pi to improve the input surface with a long prompt that must be clipped by the row planner";
			const contentLines = [longText, shortText];
			const expectedPreviewLines = Math.max(minContentRows, contentLines.length) + topMarginRows + 2;
			const previewFocused = previewFrame(dirtyState(), config, width, contentLines, true);
			const previewUnfocused = previewFrame(dirtyState(), config, width, contentLines, false);
			const liveShort = liveFrame(dirtyState(), config, width, true, shortText);
			const liveLong = liveFrame(dirtyState(), config, width, true, `${longText}\n${shortText}`);
			const firstContentIndex = topMarginRows + 1;

			assert.equal(previewFocused.length, expectedPreviewLines, `focused preview frame line count honors margin ${topMarginRows} and minRows ${minContentRows}`);
			assert.equal(previewUnfocused.length, expectedPreviewLines, `unfocused preview frame line count honors margin ${topMarginRows} and minRows ${minContentRows}`);
			assert.equal(liveShort.length, minContentRows + topMarginRows + 2, `short live frame line count honors margin ${topMarginRows} and minRows ${minContentRows}`);
			assert.ok(liveLong.length >= minContentRows + topMarginRows + 2, `long live frame keeps at least margin ${topMarginRows} and minRows ${minContentRows}`);
			assertTopMargin(previewFocused, topMarginRows, "focused preview", width);
			assertTopMargin(previewUnfocused, topMarginRows, "unfocused preview", width);
			assertTopMargin(liveShort, topMarginRows, "live short", width);
			assertTopMargin(liveLong, topMarginRows, "live long", width);
			assert.ok(previewFocused[topMarginRows]?.startsWith("╭"), `focused preview top border follows configured margin at width ${width}`);
			assert.ok(liveShort[topMarginRows]?.startsWith("╭"), `live top border follows configured margin at width ${width}`);
			assert.ok(previewFocused[firstContentIndex]?.includes("› "), `focused preview first row keeps dim prefix at width ${width}`);
			assert.ok(!(previewUnfocused[firstContentIndex] ?? "").includes("› "), `unfocused preview first row omits focus prefix at width ${width}`);
			assert.ok(previewUnfocused[firstContentIndex]?.startsWith("│  "), `unfocused preview first row keeps two-column plain prefix at width ${width}`);
			assert.ok(liveShort[firstContentIndex]?.startsWith("│ "), `live row keeps left content padding at width ${width}`);
			assert.ok(liveShort[firstContentIndex]?.endsWith(" │"), `live row keeps right content padding at width ${width}`);
			for (const [label, frame] of [
				["preview focused", previewFocused],
				["preview unfocused", previewUnfocused],
				["live short", liveShort],
				["live long", liveLong],
			] as const) {
				for (const line of frame) {
					assert.ok(visibleWidth(line) <= width, `${label} line should fit width ${width}: ${line}`);
				}
			}
		}
	}
}

console.log("✓ surface preview/live frame parity checks passed");
