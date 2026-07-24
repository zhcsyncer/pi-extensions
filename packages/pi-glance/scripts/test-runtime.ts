import { strict as assert } from "node:assert";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "../config.js";
import { PALETTES, fg } from "../palette.js";
import { renderInputSurface } from "../renderer.js";
import type { GlanceRenderStyleContext } from "../theme-adapter.js";
import {
	assistantMessage,
	createGitHarness,
	createRuntimeHarness,
	createRuntimeTestContext as createContext,
	disabledConfig,
	fakePiTheme,
	hasNotification,
	invokeEditorFactory,
	invokeFooterFactory,
	isPromiseLike,
	nextEnabledConfig,
	runtimeGitSnapshot as gitSnapshot,
	sessionMessage,
	type RuntimeHarness,
	type RuntimeHarnessOptions,
	type RuntimeTestContext,
} from "./runtime-harness.js";

type TestContext = RuntimeTestContext;
type RuntimeShowPaneResults = RuntimeHarnessOptions["showPaneResults"];

type ScanExpectation = "same" | "increased";

interface ScanCounts {
	entries: number;
	branch: number;
}

function scanCounts(test: TestContext): ScanCounts {
	return {
		entries: test.getEntryReads(),
		branch: test.getBranchReads(),
	};
}

function assertScanCounter(label: string, counter: "entries" | "branch", before: ScanCounts, after: ScanCounts, expectation: ScanExpectation): void {
	if (expectation === "same") {
		assert.equal(after[counter], before[counter], `${label} should not scan session ${counter}`);
		return;
	}
	assert.ok(after[counter] > before[counter], `${label} should scan session ${counter}`);
}

function assertScanDelta(label: string, before: ScanCounts, test: TestContext, expected: { entries: ScanExpectation; branch: ScanExpectation }): void {
	const after = scanCounts(test);
	assertScanCounter(label, "entries", before, after, expected.entries);
	assertScanCounter(label, "branch", before, after, expected.branch);
}

function assertAmbientPaneOptions(options: RuntimeHarness["showPaneOptions"][number], message: string): GlanceRenderStyleContext {
	const renderStyleContext = options?.renderStyleContext;
	assert.ok(renderStyleContext, `${message}: pane should receive a render style context`);
	assert.equal(renderStyleContext.styles, undefined, `${message}: inactive Pi style provider should not inject Pi color styles`);
	assert.equal(typeof renderStyleContext.getAmbientTone, "function", `${message}: pane render style context should provide lazy ambient tone`);
	return renderStyleContext;
}

function createScanMatrixContext(): TestContext {
	return createContext({
		entries: [sessionMessage("assistant", { usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.25 } } })],
		branch: [{ type: "compaction" }, sessionMessage("assistant", { usage: { totalTokens: 1 } })],
	});
}

interface RuntimeScanMatrixCase {
	name: string;
	showPaneResults?: RuntimeShowPaneResults;
	prepare?: (harness: RuntimeHarness, test: TestContext) => void | Promise<void>;
	invoke: (harness: RuntimeHarness, test: TestContext) => void | Promise<void>;
}

async function assertRuntimeScanMatrixCase(matrixCase: RuntimeScanMatrixCase, expected: { entries: ScanExpectation; branch: ScanExpectation }): Promise<void> {
	const git = createGitHarness();
	const test = createScanMatrixContext();
	const harness = createRuntimeHarness({ loadConfigSyncConfig: defaultConfig(), showPaneResults: matrixCase.showPaneResults, git });
	harness.runtime.events.sessionStart({}, test.ctx);
	await matrixCase.prepare?.(harness, test);
	const baseline = scanCounts(test);
	await matrixCase.invoke(harness, test);
	assertScanDelta(matrixCase.name, baseline, test, expected);
}

{
	const test = createScanMatrixContext();
	const harness = createRuntimeHarness({ loadConfigSyncConfig: defaultConfig(), git: createGitHarness() });
	const beforeSessionStart = scanCounts(test);
	harness.runtime.events.sessionStart({}, test.ctx);
	assertScanDelta("session_start", beforeSessionStart, test, { entries: "increased", branch: "increased" });
}

for (const matrixCase of [
	{
		name: "session_tree",
		invoke: (harness, test) => harness.runtime.events.sessionTree({}, test.ctx as ExtensionContext),
	},
	{
		name: "config_save_success",
		showPaneResults: [{ action: "save", config: nextEnabledConfig(defaultConfig()) }],
		invoke: (harness, test) => harness.runtime.commands.openPane("", test.ctx),
	},
] satisfies RuntimeScanMatrixCase[]) {
	await assertRuntimeScanMatrixCase(matrixCase, { entries: "increased", branch: "increased" });
}

await assertRuntimeScanMatrixCase(
	{
		name: "session_compact",
		invoke: (harness, test) => harness.runtime.events.sessionCompact({}, test.ctx as ExtensionContext),
	},
	{ entries: "increased", branch: "same" },
);

for (const matrixCase of [
	{
		name: "thinking_level_select",
		invoke: (harness, test) => harness.runtime.events.thinkingLevelSelect({}, test.ctx as ExtensionContext),
	},
	{
		name: "editor_thinking_cycle",
		invoke: async (_harness, test) => {
			const editor = invokeEditorFactory(
				test,
				0,
				() => undefined,
				{ matches: (data, action) => action === "app.thinking.cycle" && data === "t" },
			) as { handleInput(data: string): void };
			editor.handleInput("t");
			await Promise.resolve();
		},
	},
	{
		name: "session_info_changed",
		invoke: (harness, test) => harness.runtime.events.sessionInfoChanged({}, test.ctx as ExtensionContext),
	},
	{
		name: "model_select",
		invoke: (harness, test) => harness.runtime.events.modelSelect({}, test.ctx as ExtensionContext),
	},
	{
		name: "turn_start",
		invoke: (harness, test) => harness.runtime.events.turnStart({}, test.ctx as ExtensionContext),
	},
	{
		name: "tool_execution_end",
		invoke: (harness, test) => harness.runtime.events.toolExecutionEnd({}, test.ctx as ExtensionContext),
	},
	{
		name: "assistant message_end",
		invoke: (harness, test) => harness.runtime.events.messageEnd({ message: assistantMessage({ usage: { input: 2, output: 3, totalTokens: 5, cost: { total: 0.1 } } }) }, test.ctx as ExtensionContext),
	},
	{
		name: "tool-result message_end",
		invoke: (harness, test) => harness.runtime.events.messageEnd({ message: { role: "toolResult", usage: { input: 2, output: 3, totalTokens: 5 } } }, test.ctx as ExtensionContext),
	},
	{
		name: "non-assistant message_end",
		invoke: (harness, test) => harness.runtime.events.messageEnd({ message: { role: "user", usage: { input: 2, output: 3, totalTokens: 5 } } }, test.ctx as ExtensionContext),
	},
	{
		name: "turn_end",
		prepare: (harness, test) => harness.runtime.events.agentStart({}, test.ctx as ExtensionContext),
		invoke: (harness, test) => harness.runtime.events.turnEnd({ turnIndex: 1, message: assistantMessage({ usage: { output: 4, totalTokens: 4 } }) }, test.ctx as ExtensionContext),
	},
	{
		name: "agent_start",
		invoke: (harness, test) => harness.runtime.events.agentStart({}, test.ctx as ExtensionContext),
	},
	{
		name: "agent_end",
		prepare: (harness, test) => harness.runtime.events.agentStart({}, test.ctx as ExtensionContext),
		invoke: (harness, test) => harness.runtime.events.agentEnd({ messages: [assistantMessage({ usage: { output: 4, totalTokens: 4 } })] }, test.ctx as ExtensionContext),
	},
	{
		name: "session_shutdown",
		invoke: (harness, test) => harness.runtime.events.sessionShutdown({}, test.ctx as ExtensionContext),
	},
] satisfies RuntimeScanMatrixCase[]) {
	await assertRuntimeScanMatrixCase(matrixCase, { entries: "same", branch: "same" });
}

{
	const config = defaultConfig();
	const git = createGitHarness();
	const test = createContext();
	const harness = createRuntimeHarness({ loadConfigSyncConfig: config, git });
	const result = harness.runtime.events.sessionStart({}, test.ctx);

	assert.equal(isPromiseLike(result), false, "sessionStart should stay synchronous for enabled config");
	assert.deepEqual(test.surfaceCalls, ["setFooter:install", "setEditorComponent:install"], "enabled TUI sessionStart should synchronously install footer before editor");
	assert.deepEqual(git.schedules, [true], "enabled sessionStart should schedule an immediate git refresh through the adapter");
	assert.equal(harness.getLoadConfigCalls(), 0, "sessionStart should not call the async loadConfig adapter");
}

{
	const git = createGitHarness();
	const test = createContext();
	const harness = createRuntimeHarness({ loadConfigSyncConfig: disabledConfig(), git });
	const result = harness.runtime.events.sessionStart({}, test.ctx);

	assert.equal(isPromiseLike(result), false, "sessionStart should stay synchronous for disabled config");
	assert.deepEqual(test.surfaceCalls, ["setEditorComponent:clear", "setFooter:clear"], "disabled TUI sessionStart should synchronously restore editor and footer");
	assert.equal(git.created, 0, "disabled sessionStart should not create a git refresher");
	assert.equal(harness.getLoadConfigCalls(), 0, "disabled sessionStart should not call the async loadConfig adapter");
}

{
	const currentPiTheme = fakePiTheme("light");
	const git = createGitHarness();
	const test = createContext({ uiTheme: currentPiTheme });
	const harness = createRuntimeHarness({ loadConfigSyncConfig: defaultConfig(), showPaneResults: [{ action: "cancel" }], git });

	harness.runtime.events.sessionStart({}, test.ctx);
	assert.equal(test.getThemeReads(), 0, "TUI install should not eagerly read UI theme tone before render");
	assert.equal(test.editorFactories.length, 1, "enabled TUI install should still register one editor factory with a current Pi theme present");
	const editor = invokeEditorFactory(test, 0, () => undefined) as { focused: boolean; setText(text: string): void; render(width: number): string[] };
	editor.focused = true;
	editor.setText("ambient provider check");
	currentPiTheme.name = "dark";
	const darkEditorFrame = editor.render(100).join("\n");
	assert.ok(darkEditorFrame.includes(fg(PALETTES.dark.border, "╭")), "live editor should lazily resolve exact Pi UI theme name dark to the dark Glance palette");
	assert.equal(darkEditorFrame.includes("<<pi-theme:"), false, "current Pi UI theme presence should not activate Pi token color styles in the editor");
	currentPiTheme.name = "light";
	const lightEditorFrame = editor.render(100).join("\n");
	assert.ok(lightEditorFrame.includes(fg(PALETTES.light.border, "╭")), "live editor should re-read exact Pi UI theme name light on later renders");
	currentPiTheme.name = "my-dark-theme";
	const customEditorFrame = editor.render(100).join("\n");
	assert.ok(customEditorFrame.includes(fg(PALETTES.light.border, "╭")), "custom Pi UI theme names should resolve as unknown and fall back to the light Glance palette");
	test.setUiTheme(undefined);
	const missingEditorFrame = editor.render(100).join("\n");
	assert.ok(missingEditorFrame.includes(fg(PALETTES.light.border, "╭")), "missing Pi UI theme should resolve as unknown and fall back to the light Glance palette");
	assert.ok(test.getThemeReads() >= 4, "editor render should lazily read UI theme tone through the ambient seam on each style resolution");

	test.setUiTheme(currentPiTheme);
	currentPiTheme.name = "dark";
	await harness.runtime.commands.openPane("", test.ctx);
	const paneRenderStyleContext = assertAmbientPaneOptions(harness.showPaneOptions[0], "current Pi UI theme presence");
	assert.equal(paneRenderStyleContext.getAmbientTone?.(), "dark", "pane preview context should lazily resolve the current Pi UI theme name to dark");
	const previewState = harness.showPanePreviewStates[0];
	assert.ok(previewState, "pane ambient tone test should capture preview state");
	const panePreview = renderInputSurface(previewState, harness.showPaneInitials[0]!, 100, {
		...paneRenderStyleContext,
		contentLines: ["preview"],
		focused: true,
	}).join("\n");
	assert.ok(panePreview.includes(fg(PALETTES.dark.border, "╭")), "/glance preview should receive lazy dark ambient tone through Glance palettes");
	assert.equal(panePreview.includes("<<pi-theme:"), false, "/glance preview should not activate Pi token color styles");
}

{
	const config = defaultConfig();
	const git = createGitHarness();
	const test = createContext();
	const harness = createRuntimeHarness({ loadConfigSyncConfig: config, showPaneResults: [{ action: "cancel" }], git });

	harness.runtime.events.sessionStart({}, test.ctx);
	const entryBaseline = test.getEntryReads();
	const branchBaseline = test.getBranchReads();
	test.setSessionName("status composition");
	await harness.runtime.events.sessionInfoChanged({}, test.ctx as ExtensionContext);
	assert.equal(test.getEntryReads(), entryBaseline, "session_info_changed should not scan entries after session details are removed");
	assert.equal(test.getBranchReads(), branchBaseline, "session_info_changed should not scan branch");
}

{
	const config = defaultConfig();
	config.model.customNames["claude-opus-4"] = "Opus Custom";
	const git = createGitHarness();
	const test = createContext({ usingOAuth: true });
	const harness = createRuntimeHarness({
		loadConfigSyncConfig: config,
		showPaneResults: [{ action: "cancel" }],
		getAutoCompactionEnabled: () => false,
		git,
	});

	harness.runtime.events.sessionStart({}, test.ctx);
	const entryBaseline = test.getEntryReads();
	const branchBaseline = test.getBranchReads();
	assert.ok(entryBaseline > 0, "model_select counter baseline should include the session_start entries read");
	assert.ok(branchBaseline > 0, "model_select counter baseline should include the session_start branch read");
	const renderBaseline = test.getRenderRequests();
	const scheduleBaseline = git.schedules.length;
	test.setAvailableProviders(["openai", "anthropic", "openai", "local"]);
	test.setModel({ id: "claude-opus-4-20250514", provider: "anthropic", contextWindow: 500_000 });
	test.setContextUsage({ tokens: 123_456, contextWindow: 500_000, percent: 24.6912 });
	await harness.runtime.events.modelSelect({}, test.ctx as ExtensionContext);

	assert.equal(test.getEntryReads(), entryBaseline, "model_select should not scan session entries after the session_start baseline");
	assert.equal(test.getBranchReads(), branchBaseline, "model_select should not scan session branch after the session_start baseline");
	assert.deepEqual(git.schedules.slice(scheduleBaseline), [true], "model_select should preserve immediate git refresh behavior");
	assert.ok(test.getRenderRequests() > renderBaseline, "model_select should still request a render");
	await harness.runtime.commands.openPane("", test.ctx);

	const previewState = harness.showPanePreviewStates.at(-1);
	assert.ok(previewState, "model_select smoke test should open /glance with preview state");
	assert.equal(previewState.providers.availableCount, 3, "preview state should refresh unique provider count after model_select");
	assert.equal(previewState.model.id, "claude-opus-4-20250514", "preview state should refresh model id after model_select");
	assert.equal(previewState.model.provider, "anthropic", "preview state should refresh model provider after model_select");
	assert.equal(previewState.model.displayName, "Opus Custom", "preview state should refresh configured model display name after model_select");
	assert.equal(previewState.context.tokens, 123_456, "preview state should refresh context tokens after model_select");
	assert.equal(previewState.context.window, 500_000, "preview state should refresh context window after model_select");
	assert.equal(previewState.context.percent, 24.6912, "preview state should refresh context percent after model_select");
	assert.equal(previewState.runtime.autoCompactEnabled, false, "runtime should use the injected Pi auto-compaction status");
	assert.equal(test.getEntryReads(), entryBaseline, "opening /glance after model_select should not hide a session entries scan");
	assert.equal(test.getBranchReads(), branchBaseline, "opening /glance after model_select should not hide a session branch scan");
}

{
	const config = defaultConfig();
	config.model.customNames["claude-opus-4"] = "Opus Custom";
	let thinkingLevel = "off";
	const git = createGitHarness();
	const test = createContext({
		availableProviders: ["openai"],
		model: { id: "gpt-4o-mini", provider: "openai", contextWindow: 128_000 },
		contextUsage: { tokens: 99, contextWindow: 128_000, percent: 0.077 },
	});
	const harness = createRuntimeHarness({
		loadConfigSyncConfig: config,
		showPaneResults: [{ action: "cancel" }],
		getThinkingLevel: () => thinkingLevel,
		git,
	});

	harness.runtime.events.sessionStart({}, test.ctx);
	const entryBaseline = test.getEntryReads();
	const branchBaseline = test.getBranchReads();
	assert.ok(entryBaseline > 0, "thinking_level_select counter baseline should include the session_start entries read");
	assert.ok(branchBaseline > 0, "thinking_level_select counter baseline should include the session_start branch read");
	const renderBaseline = test.getRenderRequests();
	const scheduleBaseline = git.schedules.length;
	thinkingLevel = "high";
	test.setAvailableProviders(["openai", "anthropic", "openai", "local"]);
	test.setModel({ id: "claude-opus-4-20250514", provider: "anthropic", contextWindow: 500_000 });
	test.setContextUsage({ tokens: 777, contextWindow: 500_000, percent: 0.1554 });
	await harness.runtime.events.thinkingLevelSelect({}, test.ctx as ExtensionContext);

	assert.equal(test.getEntryReads(), entryBaseline, "thinking_level_select should not scan session entries after the session_start baseline");
	assert.equal(test.getBranchReads(), branchBaseline, "thinking_level_select should not scan session branch after the session_start baseline");
	assert.deepEqual(git.schedules.slice(scheduleBaseline), [], "thinking_level_select should not schedule git refreshes");
	assert.ok(test.getRenderRequests() > renderBaseline, "thinking_level_select should still request a render");
	await harness.runtime.commands.openPane("", test.ctx);

	const previewState = harness.showPanePreviewStates.at(-1);
	assert.ok(previewState, "thinking_level_select smoke test should open /glance with preview state");
	assert.equal(previewState.providers.availableCount, 3, "thinking_level_select should refresh unique provider count through the cheap path");
	assert.equal(previewState.model.id, "claude-opus-4-20250514", "thinking_level_select should refresh model id through the cheap path");
	assert.equal(previewState.model.provider, "anthropic", "thinking_level_select should refresh model provider through the cheap path");
	assert.equal(previewState.model.displayName, "Opus Custom", "thinking_level_select should honor configured model custom names");
	assert.equal(previewState.model.thinking, "high", "thinking_level_select should refresh the visible thinking level");
	assert.equal(previewState.context.tokens, 99, "thinking_level_select should not overwrite context tokens when the plan does not refresh context usage");
	assert.equal(previewState.context.window, 500_000, "thinking_level_select should refresh context window from the current model");
	assert.equal(previewState.context.percent, 0.077, "thinking_level_select should not overwrite context percent when the plan does not refresh context usage");
	assert.equal(test.getEntryReads(), entryBaseline, "opening /glance after thinking_level_select should not hide a session entries scan");
	assert.equal(test.getBranchReads(), branchBaseline, "opening /glance after thinking_level_select should not hide a session branch scan");
}

{
	const config = defaultConfig();
	config.model.customNames["gpt-5"] = "GPT Custom";
	let thinkingLevel = "off";
	const git = createGitHarness();
	const test = createContext({
		availableProviders: ["openai"],
		model: { id: "initial-model", provider: "openai", contextWindow: 100_000 },
		contextUsage: { tokens: 321, contextWindow: 100_000, percent: 0.321 },
	});
	const harness = createRuntimeHarness({
		loadConfigSyncConfig: config,
		showPaneResults: [{ action: "cancel" }],
		getThinkingLevel: () => thinkingLevel,
		git,
	});

	harness.runtime.events.sessionStart({}, test.ctx);
	assert.equal(test.editorFactories.length, 1, "enabled sessionStart should register one editor factory for editor thinking-cycle coverage");
	let editorRenderRequests = 0;
	const editor = invokeEditorFactory(
		test,
		0,
		() => editorRenderRequests++,
		{ matches: (data, action) => action === "app.thinking.cycle" && data === "t" },
	) as { handleInput(data: string): void; getText(): string };
	const entryBaseline = test.getEntryReads();
	const branchBaseline = test.getBranchReads();
	assert.ok(entryBaseline > 0, "editor_thinking_cycle counter baseline should include the session_start entries read");
	assert.ok(branchBaseline > 0, "editor_thinking_cycle counter baseline should include the session_start branch read");
	const renderBaseline = editorRenderRequests;
	const scheduleBaseline = git.schedules.length;
	thinkingLevel = "medium";
	test.setAvailableProviders(["openai", "anthropic", "anthropic"]);
	test.setModel({ id: "gpt-5-large", provider: "openai", contextWindow: 1_000_000 });
	test.setContextUsage({ tokens: 999, contextWindow: 1_000_000, percent: 0.999 });
	editor.handleInput("t");
	await Promise.resolve();

	assert.equal(test.getEntryReads(), entryBaseline, "editor_thinking_cycle should not scan session entries after the session_start baseline");
	assert.equal(test.getBranchReads(), branchBaseline, "editor_thinking_cycle should not scan session branch after the session_start baseline");
	assert.deepEqual(git.schedules.slice(scheduleBaseline), [], "editor_thinking_cycle should not schedule git refreshes");
	assert.ok(editorRenderRequests > renderBaseline, "editor_thinking_cycle should still request a render through the active editor surface");
	assert.equal(editor.getText(), "t", "editor_thinking_cycle should preserve CustomEditor text handling after the app keybinding");
	await harness.runtime.commands.openPane("", test.ctx);

	const previewState = harness.showPanePreviewStates.at(-1);
	assert.ok(previewState, "editor_thinking_cycle smoke test should open /glance with preview state");
	assert.equal(previewState.providers.availableCount, 2, "editor_thinking_cycle should refresh unique provider count through the cheap path");
	assert.equal(previewState.model.id, "gpt-5-large", "editor_thinking_cycle should refresh model id through the cheap path");
	assert.equal(previewState.model.provider, "openai", "editor_thinking_cycle should refresh model provider through the cheap path");
	assert.equal(previewState.model.displayName, "GPT Custom", "editor_thinking_cycle should honor configured model custom names");
	assert.equal(previewState.model.thinking, "medium", "editor_thinking_cycle should refresh the visible thinking level");
	assert.equal(previewState.context.tokens, 321, "editor_thinking_cycle should not overwrite context tokens when the plan does not refresh context usage");
	assert.equal(previewState.context.window, 1_000_000, "editor_thinking_cycle should refresh context window from the current model");
	assert.equal(previewState.context.percent, 0.321, "editor_thinking_cycle should not overwrite context percent when the plan does not refresh context usage");
	assert.equal(test.getEntryReads(), entryBaseline, "opening /glance after editor_thinking_cycle should not hide a session entries scan");
	assert.equal(test.getBranchReads(), branchBaseline, "opening /glance after editor_thinking_cycle should not hide a session branch scan");
}

{
	const git = createGitHarness();
	const test = createContext({ cwd: "/repo" });
	const harness = createRuntimeHarness({ loadConfigSyncConfig: defaultConfig(), showPaneResults: [{ action: "cancel" }], git });

	harness.runtime.events.sessionStart({}, test.ctx);
	const entryBaseline = test.getEntryReads();
	const branchBaseline = test.getBranchReads();
	assert.ok(entryBaseline > 0, "turn_start counter baseline should include the session_start entries read");
	assert.ok(branchBaseline > 0, "turn_start counter baseline should include the session_start branch read");
	const scheduleBaseline = git.schedules.length;
	test.setCwd("/workspace/fresh-repo");
	test.setAvailableProviders(["openai", "anthropic", "openai"]);
	test.setModel({ id: "claude-sonnet-4-20250514", provider: "anthropic", contextWindow: 400_000 });
	test.setContextUsage({ tokens: 44_000, contextWindow: 400_000, percent: 11 });
	await harness.runtime.events.turnStart({}, test.ctx as ExtensionContext);

	assert.equal(test.getEntryReads(), entryBaseline, "turn_start should not scan session entries after the session_start baseline");
	assert.equal(test.getBranchReads(), branchBaseline, "turn_start should not scan session branch after the session_start baseline");
	assert.deepEqual(git.schedules.slice(scheduleBaseline), [true], "workspace-changing turn_start should schedule one immediate git refresh for the new cwd");
	assert.equal(git.options?.getCwd(), "/workspace/fresh-repo", "git refresher getCwd should expose the refreshed turn_start workspace");
	const renderAfterTurnStart = test.getRenderRequests();
	git.options?.onSnapshot("/repo", gitSnapshot("stale-old-workspace"));
	assert.equal(test.getRenderRequests(), renderAfterTurnStart, "turn_start should keep stale old-cwd git snapshots ignored after workspace change");
	git.options?.onSnapshot("/workspace/fresh-repo", gitSnapshot("fresh-preview-branch"));
	await harness.runtime.commands.openPane("", test.ctx);

	const previewState = harness.showPanePreviewStates.at(-1);
	assert.ok(previewState, "workspace/git smoke test should open /glance with preview state");
	assert.equal(previewState.workspace.path, "/workspace/fresh-repo", "preview state should refresh workspace path after turn_start");
	assert.equal(previewState.workspace.name, "fresh-repo", "preview state should refresh workspace display name after turn_start");
	assert.equal(previewState.providers.availableCount, 2, "turn_start should refresh provider count through the lifecycle path");
	assert.equal(previewState.model.id, "claude-sonnet-4-20250514", "turn_start should refresh model id through the lifecycle path");
	assert.equal(previewState.model.provider, "anthropic", "turn_start should refresh model provider through the lifecycle path");
	assert.equal(previewState.context.tokens, 44_000, "turn_start should refresh context tokens through the lifecycle path");
	assert.equal(previewState.context.window, 400_000, "turn_start should refresh context window through the lifecycle path");
	assert.equal(previewState.context.percent, 11, "turn_start should refresh context percent through the lifecycle path");
	assert.equal(previewState.git.branch, "fresh-preview-branch", "preview state should include the latest matching git snapshot after workspace refresh");
	assert.equal(previewState.git.status, "dirty", "preview state should include git snapshot status after workspace refresh");
	assert.equal(test.getEntryReads(), entryBaseline, "opening /glance after turn_start should not hide a session entries scan");
	assert.equal(test.getBranchReads(), branchBaseline, "opening /glance after turn_start should not hide a session branch scan");
}

{
	const git = createGitHarness();
	const test = createContext({
		cwd: "/repo",
		availableProviders: ["openai"],
		model: { id: "initial-tool-model", provider: "openai", contextWindow: 100_000 },
		contextUsage: { tokens: 100, contextWindow: 100_000, percent: 0.1 },
	});
	const harness = createRuntimeHarness({ loadConfigSyncConfig: defaultConfig(), showPaneResults: [{ action: "cancel" }], git });

	harness.runtime.events.sessionStart({}, test.ctx);
	const entryBaseline = test.getEntryReads();
	const branchBaseline = test.getBranchReads();
	assert.ok(entryBaseline > 0, "tool_execution_end counter baseline should include the session_start entries read");
	assert.ok(branchBaseline > 0, "tool_execution_end counter baseline should include the session_start branch read");
	const scheduleBaseline = git.schedules.length;
	const renderBaseline = test.getRenderRequests();
	test.setCwd("/workspace/tool-repo");
	test.setAvailableProviders(["openai", "anthropic", "local", "anthropic"]);
	test.setModel({ id: "changed-tool-model", provider: "anthropic", contextWindow: 300_000 });
	test.setContextUsage({ tokens: 12_345, contextWindow: 300_000, percent: 4.115 });
	await harness.runtime.events.toolExecutionEnd({}, test.ctx as ExtensionContext);

	assert.equal(test.getEntryReads(), entryBaseline, "tool_execution_end should not scan session entries after the session_start baseline");
	assert.equal(test.getBranchReads(), branchBaseline, "tool_execution_end should not scan session branch after the session_start baseline");
	assert.deepEqual(git.schedules.slice(scheduleBaseline), [true], "tool_execution_end should preserve immediate git refresh behavior");
	assert.ok(test.getRenderRequests() > renderBaseline, "tool_execution_end should still request a render");
	assert.equal(git.options?.getCwd(), "/workspace/tool-repo", "git refresher getCwd should expose the refreshed tool_execution_end workspace");
	const renderAfterToolEnd = test.getRenderRequests();
	git.options?.onSnapshot("/repo", gitSnapshot("stale-tool-old-workspace"));
	assert.equal(test.getRenderRequests(), renderAfterToolEnd, "tool_execution_end should keep stale old-cwd git snapshots ignored after workspace change");
	git.options?.onSnapshot("/workspace/tool-repo", gitSnapshot("tool-preview-branch"));
	await harness.runtime.commands.openPane("", test.ctx);

	const previewState = harness.showPanePreviewStates.at(-1);
	assert.ok(previewState, "tool_execution_end smoke test should open /glance with preview state");
	assert.equal(previewState.workspace.path, "/workspace/tool-repo", "tool_execution_end should refresh workspace path through the lifecycle path");
	assert.equal(previewState.workspace.name, "tool-repo", "tool_execution_end should refresh workspace display name through the lifecycle path");
	assert.equal(previewState.providers.availableCount, 3, "tool_execution_end should refresh provider count through the lifecycle path");
	assert.equal(previewState.model.id, "initial-tool-model", "tool_execution_end should preserve existing model id because the event does not refresh model state");
	assert.equal(previewState.model.provider, "openai", "tool_execution_end should preserve existing model provider because the event does not refresh model state");
	assert.equal(previewState.context.tokens, 12_345, "tool_execution_end should refresh context tokens through the lifecycle path");
	assert.equal(previewState.context.window, 300_000, "tool_execution_end should refresh context window through the lifecycle path");
	assert.equal(previewState.context.percent, 4.115, "tool_execution_end should refresh context percent through the lifecycle path");
	assert.equal(previewState.git.branch, "tool-preview-branch", "tool_execution_end should accept matching new-cwd git snapshots");
	assert.equal(test.getEntryReads(), entryBaseline, "opening /glance after tool_execution_end should not hide a session entries scan");
	assert.equal(test.getBranchReads(), branchBaseline, "opening /glance after tool_execution_end should not hide a session branch scan");
}

{
	const git = createGitHarness();
	const test = createContext();
	const harness = createRuntimeHarness({ loadConfigSyncConfig: defaultConfig(), git });

	harness.runtime.events.sessionStart({}, test.ctx);
	const entryBaseline = test.getEntryReads();
	const branchBaseline = test.getBranchReads();
	await harness.runtime.events.sessionTree({}, test.ctx as ExtensionContext);
	assert.ok(test.getEntryReads() > entryBaseline, "session_tree should remain a structural full entries scan");
	assert.ok(test.getBranchReads() > branchBaseline, "session_tree should remain a structural full branch scan");
	const entryAfterTree = test.getEntryReads();
	const branchAfterTree = test.getBranchReads();
	await harness.runtime.events.sessionCompact({}, test.ctx as ExtensionContext);
	assert.ok(test.getEntryReads() > entryAfterTree, "session_compact should keep entries scan for usage totals");
	assert.equal(test.getBranchReads(), branchAfterTree, "session_compact should use explicit context-unknown state instead of a branch scan");
}

{
	const git = createGitHarness();
	const test = createContext({
		model: { id: "initial-compact-model", provider: "openai", contextWindow: 100_000 },
		contextUsage: { tokens: 10_000, contextWindow: 100_000, percent: 10 },
		entries: [sessionMessage("assistant", { usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.1 } } })],
	});
	const harness = createRuntimeHarness({
		loadConfigSyncConfig: defaultConfig(),
		showPaneResults: Array.from({ length: 7 }, () => ({ action: "cancel" as const })),
		git,
	});

	harness.runtime.events.sessionStart({}, test.ctx);
	const entryBaseline = test.getEntryReads();
	const branchBaseline = test.getBranchReads();
	assert.ok(entryBaseline > 0, "session_compact context-unknown test baseline should include session_start entries read");
	assert.ok(branchBaseline > 0, "session_compact context-unknown test baseline should include session_start branch read");
	const scheduleBaseline = git.schedules.length;
	const renderBaseline = test.getRenderRequests();
	test.setContextUsage({ tokens: 99_999, contextWindow: 100_000, percent: 99.999 });
	await harness.runtime.events.sessionCompact({}, test.ctx as ExtensionContext);

	assert.ok(test.getEntryReads() > entryBaseline, "session_compact should still scan entries for usage totals in context-unknown test");
	assert.equal(test.getBranchReads(), branchBaseline, "session_compact should not scan branch in context-unknown test");
	assert.deepEqual(git.schedules.slice(scheduleBaseline), [true], "session_compact should preserve immediate git refresh behavior");
	assert.ok(test.getRenderRequests() > renderBaseline, "session_compact should request render after clearing context");
	await harness.runtime.commands.openPane("", test.ctx);
	let previewState = harness.showPanePreviewStates.at(-1);
	assert.ok(previewState, "session_compact context clear should open /glance with preview state");
	assert.deepEqual(previewState.usage, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.1 }, "session_compact should preserve usage totals from entries");
	assert.equal(previewState.context.tokens, null, "session_compact should clear visible context tokens to unknown");
	assert.equal(previewState.context.window, 100_000, "session_compact should preserve current context window");
	assert.equal(previewState.context.percent, null, "session_compact should clear visible context percent to unknown");

	test.setAvailableProviders(["openai", "anthropic"]);
	test.setModel({ id: "post-compact-model", provider: "anthropic", contextWindow: 200_000 });
	test.setContextUsage({ tokens: 88_000, contextWindow: 200_000, percent: 44 });
	const entryAfterCompact = test.getEntryReads();
	const branchAfterCompact = test.getBranchReads();
	await harness.runtime.events.modelSelect({}, test.ctx as ExtensionContext);
	await harness.runtime.events.turnStart({}, test.ctx as ExtensionContext);
	await harness.runtime.events.toolExecutionEnd({}, test.ctx as ExtensionContext);
	await harness.runtime.events.turnEnd({ turnIndex: 7, message: assistantMessage({ responseId: "turn-known-after-compact", usage: { totalTokens: 88_000, input: 1, output: 1 } }) }, test.ctx as ExtensionContext);
	await harness.runtime.events.agentEnd({ messages: [assistantMessage({ responseId: "agent-known-after-compact", usage: { totalTokens: 88_000, input: 1, output: 1 } })] }, test.ctx as ExtensionContext);
	await harness.runtime.events.messageEnd({ message: { role: "user", usage: { totalTokens: 999 } } }, test.ctx as ExtensionContext);
	await harness.runtime.events.messageEnd({ message: { role: "toolResult", usage: { totalTokens: 999 } } }, test.ctx as ExtensionContext);
	await harness.runtime.events.messageEnd({ message: assistantMessage({ responseId: "missing-usage-after-compact" }) }, test.ctx as ExtensionContext);
	await harness.runtime.events.messageEnd({ message: assistantMessage({ responseId: "zero-usage-after-compact", usage: { totalTokens: 0, input: 10, output: 10 } }) }, test.ctx as ExtensionContext);
	await harness.runtime.events.messageEnd({ message: assistantMessage({ responseId: "aborted-after-compact", stopReason: "aborted", usage: { totalTokens: 100, input: 10 } }) }, test.ctx as ExtensionContext);
	await harness.runtime.events.messageEnd({ message: assistantMessage({ responseId: "error-after-compact", stopReason: "error", usage: { totalTokens: 100, input: 10 } }) }, test.ctx as ExtensionContext);
	assert.equal(test.getEntryReads(), entryAfterCompact, "lifecycle/message/turn_end/agent_end events after compact should not scan entries while context is unknown");
	assert.equal(test.getBranchReads(), branchAfterCompact, "lifecycle/message/turn_end/agent_end events after compact should not scan branch while context is unknown");
	await harness.runtime.commands.openPane("", test.ctx);
	previewState = harness.showPanePreviewStates.at(-1);
	assert.ok(previewState, "post-compact stale context check should open /glance with preview state");
	assert.equal(previewState.providers.availableCount, 2, "post-compact lifecycle refreshes should still update provider count");
	assert.equal(previewState.model.id, "post-compact-model", "post-compact model_select should still update model id");
	assert.equal(previewState.context.tokens, null, "post-compact lifecycle/message refreshes should not refill stale context tokens");
	assert.equal(previewState.context.window, 200_000, "post-compact lifecycle refreshes should still update context window");
	assert.equal(previewState.context.percent, null, "post-compact lifecycle/message refreshes should not refill stale context percent");

	test.setContextUsage({ tokens: 55_000, contextWindow: 200_000, percent: 27.5 });
	const branchBeforeKnownAssistant = test.getBranchReads();
	await harness.runtime.events.messageEnd({ message: assistantMessage({ responseId: "known-after-compact", usage: { totalTokens: 55_000, input: 5, output: 6, cost: { total: 0.2 } } }) }, test.ctx as ExtensionContext);
	assert.equal(test.getBranchReads(), branchBeforeKnownAssistant, "valid assistant context recovery should not scan branch");
	await harness.runtime.commands.openPane("", test.ctx);
	previewState = harness.showPanePreviewStates.at(-1);
	assert.ok(previewState, "valid assistant context recovery should open /glance with preview state");
	assert.equal(previewState.context.tokens, 55_000, "valid assistant context usage should clear unknown and refresh context tokens");
	assert.equal(previewState.context.window, 200_000, "valid assistant context usage should keep the current context window");
	assert.equal(previewState.context.percent, 27.5, "valid assistant context usage should clear unknown and refresh context percent");

	test.setSessionBranch([{ type: "compaction" }]);
	test.setSessionEntries([sessionMessage("assistant", { usage: { input: 8, output: 9, cost: { total: 0.3 } } })]);
	test.setContextUsage({ tokens: 66_000, contextWindow: 200_000, percent: 33 });
	const branchBeforeFullSync = test.getBranchReads();
	await harness.runtime.events.sessionTree({}, test.ctx as ExtensionContext);
	assert.ok(test.getBranchReads() > branchBeforeFullSync, "session_tree should still sync context-unknown state from branch-derived facts");
	await harness.runtime.commands.openPane("", test.ctx);
	previewState = harness.showPanePreviewStates.at(-1);
	assert.ok(previewState, "full branch sync unknown check should open /glance with preview state");
	assert.equal(previewState.context.tokens, null, "full branch sync should restore explicit unknown context when branch is compacted without known assistant usage");
	assert.equal(previewState.context.percent, null, "full branch sync should clear context percent when branch is compacted without known assistant usage");
}

{
	const git = createGitHarness();
	const test = createContext();
	const harness = createRuntimeHarness({
		loadConfigSyncConfig: defaultConfig(),
		showPaneResults: [{ action: "cancel" }, { action: "cancel" }, { action: "cancel" }, { action: "cancel" }, { action: "cancel" }],
		git,
	});

	harness.runtime.events.sessionStart({}, test.ctx);
	const entryBaseline = test.getEntryReads();
	const branchBaseline = test.getBranchReads();
	assert.ok(entryBaseline > 0, "assistant message_end counter baseline should include the session_start entries read");
	assert.ok(branchBaseline > 0, "assistant message_end counter baseline should include the session_start branch read");
	const renderBaseline = test.getRenderRequests();
	const scheduleBaseline = git.schedules.length;
	await harness.runtime.events.messageEnd({ message: { role: "user", usage: { input: 100, output: 100, cost: { total: 100 } } } }, test.ctx as ExtensionContext);
	assert.equal(test.getEntryReads(), entryBaseline, "user message_end should not scan session entries after the session_start baseline");
	assert.equal(test.getBranchReads(), branchBaseline, "user message_end should not scan session branch after the session_start baseline");
	assert.equal(test.getRenderRequests(), renderBaseline, "user message_end should remain no-render");
	assert.deepEqual(git.schedules.slice(scheduleBaseline), [], "user message_end should not schedule git refreshes");
	const firstMessage = assistantMessage({ responseId: "resp-1", usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14, cost: { total: 0.5, input: 10 } } });
	await harness.runtime.events.messageEnd({ message: firstMessage }, test.ctx as ExtensionContext);

	assert.equal(test.getEntryReads(), entryBaseline, "assistant message_end should not scan session entries after the session_start baseline");
	assert.equal(test.getBranchReads(), branchBaseline, "assistant message_end should not scan session branch after the session_start baseline");
	assert.deepEqual(git.schedules.slice(scheduleBaseline), [], "assistant message_end should not schedule git refresh when workspace is unchanged");
	assert.ok(test.getRenderRequests() > renderBaseline, "assistant message_end should still request a render");
	await harness.runtime.commands.openPane("", test.ctx);
	let previewState = harness.showPanePreviewStates.at(-1);
	assert.ok(previewState, "assistant message_end should open /glance with preview state");
	assert.deepEqual(previewState.usage, { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.5 }, "assistant message_end should add message-level usage with cost.total semantics");

	await harness.runtime.events.messageEnd(
		{ message: assistantMessage({ responseId: "resp-1", usage: { input: 100, output: 100, cacheRead: 100, cacheWrite: 100, cost: { total: 100 } } }) },
		test.ctx as ExtensionContext,
	);
	await harness.runtime.commands.openPane("", test.ctx);
	previewState = harness.showPanePreviewStates.at(-1);
	assert.ok(previewState, "duplicate responseId check should open /glance with preview state");
	assert.deepEqual(previewState.usage, { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.5 }, "assistant message_end should dedupe repeated responseId deltas");

	const objectIdentityMessage = assistantMessage({ usage: { input: 7, output: 8, cacheRead: 9, cacheWrite: 10, cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4 } } });
	await harness.runtime.events.messageEnd({ message: objectIdentityMessage }, test.ctx as ExtensionContext);
	await harness.runtime.events.messageEnd({ message: objectIdentityMessage }, test.ctx as ExtensionContext);
	await harness.runtime.commands.openPane("", test.ctx);
	previewState = harness.showPanePreviewStates.at(-1);
	assert.ok(previewState, "object identity dedupe check should open /glance with preview state");
	assert.deepEqual(previewState.usage, { input: 9, output: 11, cacheRead: 13, cacheWrite: 15, cost: 1.5 }, "assistant message_end should add component-cost fallback once for duplicate object events");
	assert.equal(test.getEntryReads(), entryBaseline, "assistant message_end duplicate checks should still avoid entries scans");
	assert.equal(test.getBranchReads(), branchBaseline, "assistant message_end duplicate checks should still avoid branch scans");

	test.setSessionEntries([sessionMessage("assistant", { usage: { input: 20, output: 30, cacheRead: 40, cacheWrite: 50, cost: { total: 2.5 } } })]);
	test.setSessionBranch([{ type: "compaction" }]);
	test.setCwd("/workspace/turn-end-repo");
	test.setContextUsage({ tokens: 22_000, contextWindow: 200_000, percent: 11 });
	const scheduleBeforeTurnEnd = git.schedules.length;
	await harness.runtime.events.turnEnd({ turnIndex: 1, message: firstMessage }, test.ctx as ExtensionContext);
	assert.equal(test.getEntryReads(), entryBaseline, "turn_end should not scan session entries after assistant message_end");
	assert.equal(test.getBranchReads(), branchBaseline, "turn_end should not scan session branch after assistant message_end");
	assert.deepEqual(git.schedules.slice(scheduleBeforeTurnEnd), [true], "workspace-changing turn_end should schedule one immediate git refresh for the new cwd");
	assert.equal(git.options?.getCwd(), "/workspace/turn-end-repo", "git refresher getCwd should expose the refreshed turn_end workspace");
	await harness.runtime.commands.openPane("", test.ctx);
	previewState = harness.showPanePreviewStates.at(-1);
	assert.ok(previewState, "turn_end narrow refresh check should open /glance with preview state");
	assert.equal(previewState.workspace.path, "/workspace/turn-end-repo", "turn_end should still refresh workspace through the lifecycle path");
	assert.equal(previewState.context.tokens, 22_000, "turn_end should still refresh context tokens through the lifecycle path");
	assert.deepEqual(previewState.usage, { input: 9, output: 11, cacheRead: 13, cacheWrite: 15, cost: 1.5 }, "turn_end should preserve assistant message_end usage totals without full entries reconciliation");

	test.setSessionEntries([sessionMessage("assistant", { usage: { input: 100, output: 200, cacheRead: 300, cacheWrite: 400, cost: { total: 9.9 } } })]);
	test.setSessionBranch([{ type: "compaction" }, sessionMessage("assistant", { usage: { totalTokens: 0 } })]);
	test.setCwd("/workspace/agent-end-repo");
	test.setContextUsage({ tokens: 33_000, contextWindow: 200_000, percent: 16.5 });
	const entryAfterTurnEnd = test.getEntryReads();
	const branchAfterTurnEnd = test.getBranchReads();
	const scheduleBeforeAgentEnd = git.schedules.length;
	await harness.runtime.events.agentEnd({ messages: [assistantMessage({ usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0.4 } } })] }, test.ctx as ExtensionContext);
	assert.equal(test.getEntryReads(), entryAfterTurnEnd, "agent_end should not scan session entries after the session_start baseline");
	assert.equal(test.getBranchReads(), branchAfterTurnEnd, "agent_end should not scan session branch after the session_start baseline");
	assert.deepEqual(git.schedules.slice(scheduleBeforeAgentEnd), [true], "workspace-changing agent_end should schedule one immediate git refresh for the new cwd");
	assert.equal(git.options?.getCwd(), "/workspace/agent-end-repo", "git refresher getCwd should expose the refreshed agent_end workspace");
	await harness.runtime.commands.openPane("", test.ctx);
	previewState = harness.showPanePreviewStates.at(-1);
	assert.ok(previewState, "agent_end narrow refresh check should open /glance with preview state");
	assert.equal(previewState.workspace.path, "/workspace/agent-end-repo", "agent_end should still refresh workspace through the lifecycle path");
	assert.equal(previewState.context.tokens, 33_000, "agent_end should still refresh context tokens through the lifecycle path");
	assert.deepEqual(previewState.usage, { input: 9, output: 11, cacheRead: 13, cacheWrite: 15, cost: 1.5 }, "agent_end should preserve assistant message_end usage totals without full entries reconciliation");
}

{
	const initialConfig = defaultConfig();
	const nextConfig = disabledConfig(initialConfig);
	const git = createGitHarness();
	const test = createContext();
	const harness = createRuntimeHarness({
		loadConfigSyncConfig: initialConfig,
		showPaneResults: [{ action: "save", config: nextConfig }, { action: "cancel" }],
		saveConfigError: new Error("blocked"),
		git,
	});

	harness.runtime.events.sessionStart({}, test.ctx);
	const surfaceBaseline = test.surfaceCalls.length;
	const scheduleBaseline = git.schedules.length;
	const renderBaseline = test.getRenderRequests();
	await harness.runtime.commands.openPane("", test.ctx);

	assert.equal(hasNotification(test.notifications, "pi-glance configuration save failed; keeping previous configuration", "error"), true, "save failure should notify the exact error copy");
	assert.equal(hasNotification(test.notifications, "pi-glance configuration saved", "info"), false, "save failure should not notify success");
	assert.deepEqual(test.surfaceCalls.slice(surfaceBaseline), [], "save failure should not reinstall or clear the input surface");
	assert.deepEqual(git.schedules.slice(scheduleBaseline), [], "save failure should not schedule git refreshes");
	assert.equal(test.getRenderRequests(), renderBaseline, "save failure should not request a render");
	assert.deepEqual(harness.savedConfigs, [], "failed save should not record a persisted config");
	git.options?.onSnapshot("/repo", gitSnapshot("after-enabled-save-failure"));
	assert.equal(test.getRenderRequests(), renderBaseline + 1, "save failure should preserve the existing render owner for later git updates");

	await harness.runtime.commands.openPane("", test.ctx);
	assert.deepEqual(harness.showPaneInitials[1], initialConfig, "after failed save, the active config should still be the previous config");
	assert.equal(harness.showPanePreviewStates[1]?.git.branch, "after-enabled-save-failure", "later pane opens after failed save should receive the current preview state");
	assertAmbientPaneOptions(harness.showPaneOptions[1], "after failed save");
}

{
	const initialConfig = defaultConfig();
	const nextConfig = nextEnabledConfig(initialConfig);
	const git = createGitHarness();
	const test = createContext();
	let surfaceBaseline = -1;
	let scheduleBaseline = -1;
	let renderBaseline = -1;
	const harness = createRuntimeHarness({
		loadConfigSyncConfig: initialConfig,
		showPaneResults: [{ action: "save", config: nextConfig }, { action: "cancel" }],
		onSaveConfig: (savingConfig) => {
			assert.equal(savingConfig, nextConfig, "saveConfig should receive the pane result config before active config is swapped");
			assert.deepEqual(git.options?.getConfig(), initialConfig.git, "active config should remain unchanged while disk save is still pending");
			assert.deepEqual(test.surfaceCalls.slice(surfaceBaseline), [], "enabled->enabled save should not reinstall the surface before disk save succeeds");
			assert.deepEqual(git.schedules.slice(scheduleBaseline), [], "enabled->enabled save should not schedule git refresh before disk save succeeds");
			assert.equal(test.getRenderRequests(), renderBaseline, "enabled->enabled save should not render before disk save succeeds");
		},
		git,
	});

	harness.runtime.events.sessionStart({}, test.ctx);
	surfaceBaseline = test.surfaceCalls.length;
	scheduleBaseline = git.schedules.length;
	renderBaseline = test.getRenderRequests();
	await harness.runtime.commands.openPane("", test.ctx);

	assert.deepEqual(harness.savedConfigs, [nextConfig], "save success should pass the next config to saveConfig");
	assert.equal(hasNotification(test.notifications, "pi-glance configuration saved", "info"), true, "save success should notify saved");
	assert.equal(harness.showPaneContexts[0], test.ctx, "showPane should receive the command context passed to /glance");
	assert.equal(harness.showPanePreviewStates[0]?.workspace.path, "/repo", "showPane should receive the current runtime state for preview rendering");
	assertAmbientPaneOptions(harness.showPaneOptions[0], "default pane open");
	assert.deepEqual(test.surfaceCalls.slice(surfaceBaseline), ["setFooter:install", "setEditorComponent:install"], "save success should reinstall the enabled TUI input surface");
	assert.ok(git.schedules.length > scheduleBaseline, "enabled->enabled save success should schedule git refreshes only after disk save succeeds");
	assert.ok(test.getRenderRequests() > renderBaseline, "save success should request a render after reinstalling the surface");
	assert.deepEqual(git.options?.getConfig(), nextConfig.git, "existing git refresher should read the updated active git config after save success");

	await harness.runtime.commands.openPane("", test.ctx);
	assert.deepEqual(harness.showPaneInitials[1], nextConfig, "after successful save, later pane opens should receive the next active config");
	assertAmbientPaneOptions(harness.showPaneOptions[1], "later pane open after save");
}

{
	const initialConfig = defaultConfig();
	const nextConfig = disabledConfig(initialConfig);
	const git = createGitHarness();
	const test = createContext();
	let surfaceBaseline = -1;
	let renderBaseline = -1;
	const harness = createRuntimeHarness({
		loadConfigSyncConfig: initialConfig,
		showPaneResults: [{ action: "save", config: nextConfig }, { action: "cancel" }],
		onSaveConfig: () => {
			assert.deepEqual(git.options?.getConfig(), initialConfig.git, "enabled->disabled active config should remain enabled while disk save is pending");
			assert.deepEqual(test.surfaceCalls.slice(surfaceBaseline), [], "enabled->disabled save should not clear the surface before disk save succeeds");
			assert.equal(test.getRenderRequests(), renderBaseline, "enabled->disabled save should not render before disk save succeeds");
		},
		git,
	});

	harness.runtime.events.sessionStart({}, test.ctx);
	surfaceBaseline = test.surfaceCalls.length;
	renderBaseline = test.getRenderRequests();
	await harness.runtime.commands.openPane("", test.ctx);

	assert.deepEqual(harness.savedConfigs, [nextConfig], "enabled->disabled success should persist the disabled config");
	assert.deepEqual(test.surfaceCalls.slice(surfaceBaseline), ["setEditorComponent:clear", "setFooter:clear"], "enabled->disabled success should clear the TUI input surface after disk save succeeds");
	assert.equal(git.disposeCount, 1, "enabled->disabled success should dispose the active git refresher");
	assert.equal(test.getRenderRequests(), renderBaseline, "enabled->disabled success should not render through the cleared surface");

	await harness.runtime.commands.openPane("", test.ctx);
	assert.deepEqual(harness.showPaneInitials[1], nextConfig, "after enabled->disabled save, later pane opens should receive disabled active config");
	assertAmbientPaneOptions(harness.showPaneOptions[1], "disabled active config pane open");
}

{
	const initialConfig = disabledConfig();
	const nextConfig = nextEnabledConfig(initialConfig);
	const git = createGitHarness();
	const test = createContext();
	let surfaceBaseline = -1;
	const harness = createRuntimeHarness({
		loadConfigSyncConfig: initialConfig,
		showPaneResults: [{ action: "save", config: nextConfig }, { action: "cancel" }],
		onSaveConfig: () => {
			assert.equal(git.created, 0, "disabled->enabled save should not create a git refresher before disk save succeeds");
			assert.deepEqual(test.surfaceCalls.slice(surfaceBaseline), [], "disabled->enabled save should not install the surface before disk save succeeds");
		},
		git,
	});

	harness.runtime.events.sessionStart({}, test.ctx);
	surfaceBaseline = test.surfaceCalls.length;
	await harness.runtime.commands.openPane("", test.ctx);

	assert.deepEqual(harness.savedConfigs, [nextConfig], "disabled->enabled success should persist the enabled config");
	assert.deepEqual(test.surfaceCalls.slice(surfaceBaseline), ["setFooter:install", "setEditorComponent:install"], "disabled->enabled success should install the TUI input surface after disk save succeeds");
	assert.equal(git.created, 1, "disabled->enabled success should create the git refresher after disk save succeeds");
	assert.deepEqual(git.schedules, [true], "disabled->enabled success should schedule one immediate git refresh after installing the surface");
	assert.deepEqual(git.options?.getConfig(), nextConfig.git, "new git refresher should read the enabled active git config after save success");

	await harness.runtime.commands.openPane("", test.ctx);
	assert.deepEqual(harness.showPaneInitials[1], nextConfig, "after disabled->enabled save, later pane opens should receive enabled active config");
	assertAmbientPaneOptions(harness.showPaneOptions[1], "enabled active config pane open");
}

{
	const initialConfig = disabledConfig();
	const nextConfig = nextEnabledConfig(initialConfig);
	const git = createGitHarness();
	const test = createContext();
	const harness = createRuntimeHarness({
		loadConfigSyncConfig: initialConfig,
		showPaneResults: [{ action: "save", config: nextConfig }, { action: "cancel" }],
		saveConfigError: new Error("blocked"),
		git,
	});

	harness.runtime.events.sessionStart({}, test.ctx);
	const surfaceBaseline = test.surfaceCalls.length;
	await harness.runtime.commands.openPane("", test.ctx);

	assert.equal(hasNotification(test.notifications, "pi-glance configuration save failed; keeping previous configuration", "error"), true, "disabled-start save failure should notify the exact error copy");
	assert.deepEqual(harness.savedConfigs, [], "disabled-start failed save should not record a persisted config");
	assert.deepEqual(test.surfaceCalls.slice(surfaceBaseline), [], "disabled-start save failure should not install or clear the input surface");
	assert.equal(git.created, 0, "disabled-start save failure should not create a git refresher");

	await harness.runtime.commands.openPane("", test.ctx);
	assert.deepEqual(harness.showPaneInitials[1], initialConfig, "after disabled-start failed save, later pane opens should receive the previous disabled config");
	assertAmbientPaneOptions(harness.showPaneOptions[1], "failed disabled-start save pane open");
}

for (const startingEnabled of [true, false] as const) {
	const initialConfig = startingEnabled ? defaultConfig() : disabledConfig();
	const git = createGitHarness();
	const test = createContext();
	const harness = createRuntimeHarness({
		loadConfigSyncConfig: initialConfig,
		showPaneResults: [{ action: "cancel" }, { action: "cancel" }],
		git,
	});

	harness.runtime.events.sessionStart({}, test.ctx);
	const surfaceBaseline = test.surfaceCalls.length;
	const scheduleBaseline = git.schedules.length;
	const renderBaseline = test.getRenderRequests();
	await harness.runtime.commands.openPane("", test.ctx);

	assert.equal(hasNotification(test.notifications, "pi-glance configuration cancelled", "info"), true, `${startingEnabled ? "enabled" : "disabled"} cancel should notify cancellation`);
	assert.deepEqual(harness.savedConfigs, [], `${startingEnabled ? "enabled" : "disabled"} cancel should not save config`);
	assert.deepEqual(test.surfaceCalls.slice(surfaceBaseline), [], `${startingEnabled ? "enabled" : "disabled"} cancel should not install or clear the surface`);
	assert.deepEqual(git.schedules.slice(scheduleBaseline), [], `${startingEnabled ? "enabled" : "disabled"} cancel should not schedule git refreshes`);
	assert.equal(test.getRenderRequests(), renderBaseline, `${startingEnabled ? "enabled" : "disabled"} cancel should not request render`);
	assert.equal(harness.showPanePreviewStates[0]?.workspace.path, "/repo", `${startingEnabled ? "enabled" : "disabled"} cancel pane should receive current preview state`);
	assertAmbientPaneOptions(harness.showPaneOptions[0], `${startingEnabled ? "enabled" : "disabled"} cancel pane`);

	await harness.runtime.commands.openPane("", test.ctx);
	assert.deepEqual(harness.showPaneInitials[1], initialConfig, `${startingEnabled ? "enabled" : "disabled"} cancel should preserve active config for later pane opens`);
}

{
	const initialConfig = defaultConfig();
	const nextConfig = nextEnabledConfig(initialConfig);
	const git = createGitHarness();
	const test = createContext({ invokeFooterFactory: false });
	const harness = createRuntimeHarness({
		loadConfigSyncConfig: initialConfig,
		showPaneResults: [{ action: "save", config: nextConfig }],
		git,
	});

	harness.runtime.events.sessionStart({}, test.ctx);
	assert.equal(test.footerFactories.length, 1, "initial install should register one footer factory");
	let staleFooterRenders = 0;
	let currentFooterRenders = 0;
	invokeFooterFactory(test, 0, () => staleFooterRenders++);
	git.options?.onSnapshot("/repo", gitSnapshot("before-footer-reinstall"));
	assert.equal(staleFooterRenders, 1, "initial footer factory should own render before reinstall");

	await harness.runtime.commands.openPane("", test.ctx);
	assert.equal(test.footerFactories.length, 2, "enabled save should register a replacement footer factory");
	assert.equal(staleFooterRenders, 1, "enabled reinstall should clear the previous render callback before post-save render");

	invokeFooterFactory(test, 1, () => currentFooterRenders++);
	invokeFooterFactory(test, 0, () => staleFooterRenders++);
	git.options?.onSnapshot("/repo", gitSnapshot("after-footer-reinstall"));
	assert.equal(staleFooterRenders, 1, "stale footer factory should not regain render ownership after reinstall");
	assert.equal(currentFooterRenders, 1, "newest footer factory should remain the active render owner after stale factory invocation");
}

{
	const initialConfig = defaultConfig();
	const nextConfig = nextEnabledConfig(initialConfig);
	const git = createGitHarness();
	const test = createContext({ invokeFooterFactory: false });
	const harness = createRuntimeHarness({
		loadConfigSyncConfig: initialConfig,
		showPaneResults: [{ action: "save", config: nextConfig }],
		git,
	});

	harness.runtime.events.sessionStart({}, test.ctx);
	assert.equal(test.editorFactories.length, 1, "initial install should register one editor factory");
	let staleEditorRenders = 0;
	let currentEditorRenders = 0;
	invokeEditorFactory(test, 0, () => staleEditorRenders++);
	git.options?.onSnapshot("/repo", gitSnapshot("before-editor-reinstall"));
	assert.equal(staleEditorRenders, 1, "initial editor factory should own render before reinstall");

	await harness.runtime.commands.openPane("", test.ctx);
	assert.equal(test.editorFactories.length, 2, "enabled save should register a replacement editor factory");
	assert.equal(staleEditorRenders, 1, "enabled reinstall should clear the previous editor render callback before post-save render");

	invokeEditorFactory(test, 1, () => currentEditorRenders++);
	invokeEditorFactory(test, 0, () => staleEditorRenders++);
	git.options?.onSnapshot("/repo", gitSnapshot("after-editor-reinstall"));
	assert.equal(staleEditorRenders, 1, "stale editor factory should not regain render ownership after reinstall");
	assert.equal(currentEditorRenders, 1, "newest editor factory should remain the active render owner after stale factory invocation");
}

{
	const initialConfig = defaultConfig();
	const nextConfig = disabledConfig(initialConfig);
	const git = createGitHarness();
	const test = createContext({ invokeFooterFactory: false });
	const harness = createRuntimeHarness({
		loadConfigSyncConfig: initialConfig,
		showPaneResults: [{ action: "save", config: nextConfig }],
		git,
	});

	harness.runtime.events.sessionStart({}, test.ctx);
	let staleFooterRenders = 0;
	let staleEditorRenders = 0;
	invokeFooterFactory(test, 0, () => staleFooterRenders++);
	invokeEditorFactory(test, 0, () => staleEditorRenders++);
	git.options?.onSnapshot("/repo", gitSnapshot("before-disabled-clear"));
	assert.equal(staleEditorRenders, 1, "latest initial editor factory should own render before disabled clear");

	await harness.runtime.commands.openPane("", test.ctx);
	assert.equal(staleFooterRenders, 0, "disabled clear should not use older footer render callback during post-save render");
	assert.equal(staleEditorRenders, 1, "disabled clear should remove latest editor render callback before post-save render");

	invokeFooterFactory(test, 0, () => staleFooterRenders++);
	invokeEditorFactory(test, 0, () => staleEditorRenders++);
	git.options?.onSnapshot("/repo", gitSnapshot("after-disabled-clear"));
	assert.equal(staleFooterRenders, 0, "stale footer factory should not revive render ownership after disabled clear");
	assert.equal(staleEditorRenders, 1, "stale editor factory should not revive render ownership after disabled clear");
}

{
	const initialConfig = defaultConfig();
	const git = createGitHarness();
	const test = createContext({ invokeFooterFactory: false });
	const harness = createRuntimeHarness({ loadConfigSyncConfig: initialConfig, git });

	harness.runtime.events.sessionStart({}, test.ctx);
	let staleFooterRenders = 0;
	let staleEditorRenders = 0;
	invokeFooterFactory(test, 0, () => staleFooterRenders++);
	invokeEditorFactory(test, 0, () => staleEditorRenders++);
	git.options?.onSnapshot("/repo", gitSnapshot("before-shutdown"));
	assert.equal(staleEditorRenders, 1, "latest initial editor factory should own render before shutdown");

	await harness.runtime.events.sessionShutdown({}, test.ctx as ExtensionContext);
	invokeFooterFactory(test, 0, () => staleFooterRenders++);
	invokeEditorFactory(test, 0, () => staleEditorRenders++);
	git.options?.onSnapshot("/repo", gitSnapshot("after-shutdown"));
	assert.equal(staleFooterRenders, 0, "stale footer factory should not revive render ownership after shutdown");
	assert.equal(staleEditorRenders, 1, "stale editor factory should not revive render ownership after shutdown");
	assert.equal(git.disposeCount, 1, "shutdown should still dispose the runtime git refresher");
}

{
	const initialConfig = defaultConfig();
	const git = createGitHarness();
	const test = createContext({ cwd: "/repo" });
	const harness = createRuntimeHarness({ loadConfigSyncConfig: initialConfig, git });

	harness.runtime.events.sessionStart({}, test.ctx);
	assert.equal(git.created, 1, "enabled sessionStart should create one git refresher through the adapter");
	assert.deepEqual(git.schedules, [true], "enabled sessionStart should schedule an immediate git refresh");
	assert.equal(git.options?.getCwd(), "/repo", "git refresher getCwd should expose the current state workspace path");

	const renderBaseline = test.getRenderRequests();
	git.options?.onSnapshot("/other", gitSnapshot("other"));
	assert.equal(test.getRenderRequests(), renderBaseline, "git snapshots for a stale cwd should not request render");

	git.options?.onSnapshot("/repo", gitSnapshot("main"));
	assert.equal(test.getRenderRequests(), renderBaseline + 1, "matching git snapshots should update state and request render");

	await harness.runtime.events.sessionShutdown({}, test.ctx as ExtensionContext);
	assert.equal(git.disposeCount, 1, "sessionShutdown should dispose the runtime git refresher");
}

{
	const git = createGitHarness();
	const test = createContext({ mode: "rpc", hasUI: true });
	const harness = createRuntimeHarness({ loadConfigSyncConfig: defaultConfig(), git });

	harness.runtime.events.sessionStart({}, test.ctx);
	assert.deepEqual(test.surfaceCalls, [], "RPC mode should not install custom TUI footer/editor even though ctx.hasUI is true");
	assert.equal(git.created, 0, "RPC mode should not start the TUI-only git refresher/input surface");
	await harness.runtime.events.sessionShutdown({}, test.ctx as ExtensionContext);
	assert.deepEqual(test.surfaceCalls, [], "RPC shutdown should not clear custom TUI components that were never installed");
}

{
	for (const mode of ["json", "print"] as const) {
		const git = createGitHarness();
		const test = createContext({ mode, hasUI: false });
		const harness = createRuntimeHarness({ loadConfigSyncConfig: defaultConfig(), git });

		harness.runtime.events.sessionStart({}, test.ctx);
		assert.deepEqual(test.surfaceCalls, [], `${mode} mode should not install custom TUI footer/editor`);
		assert.equal(git.created, 0, `${mode} mode should not start the TUI-only git refresher/input surface`);
		await harness.runtime.events.sessionShutdown({}, test.ctx as ExtensionContext);
		assert.deepEqual(test.surfaceCalls, [], `${mode} shutdown should not clear custom TUI components that were never installed`);
	}
}

for (const mode of ["rpc", "json", "print"] as const) {
	const git = createGitHarness();
	const test = createContext({ mode, hasUI: true, uiTheme: fakePiTheme(`${mode}-theme`) });
	const harness = createRuntimeHarness({ loadConfigSyncConfig: defaultConfig(), showPaneResults: [{ action: "cancel" }], git });

	harness.runtime.events.sessionStart({}, test.ctx);
	await harness.runtime.events.modelSelect({}, test.ctx as ExtensionContext);
	await harness.runtime.events.thinkingLevelSelect({}, test.ctx as ExtensionContext);
	await harness.runtime.events.toolExecutionEnd({}, test.ctx as ExtensionContext);
	await harness.runtime.events.sessionTree({}, test.ctx as ExtensionContext);
	await harness.runtime.events.sessionCompact({}, test.ctx as ExtensionContext);
	await harness.runtime.events.messageEnd({ message: { role: "assistant" } }, test.ctx as ExtensionContext);
	await harness.runtime.events.turnEnd({ turnIndex: 1, message: { role: "assistant" } }, test.ctx as ExtensionContext);
	harness.runtime.events.agentStart({}, test.ctx as ExtensionContext);
	await harness.runtime.events.agentEnd({ messages: [] }, test.ctx as ExtensionContext);
	await harness.runtime.commands.openPane("", test.ctx);
	await harness.runtime.events.sessionShutdown({}, test.ctx as ExtensionContext);

	assert.deepEqual(test.surfaceCalls, [], `${mode} mode should not touch TUI surface APIs across lifecycle events even when hasUI/theme exist`);
	assert.equal(git.created, 0, `${mode} mode should not create the TUI-only git refresher across lifecycle events`);
	assert.equal(test.getThemeReads(), 0, `${mode} mode should not read the current UI theme because TUI-only provider paths are skipped`);
	assert.deepEqual(harness.showPaneInitials, [], `${mode} /glance should not invoke the custom pane adapter`);
	assert.equal(hasNotification(test.notifications, "pi-glance configuration pane requires TUI mode", "error"), true, `${mode} /glance should notify that the pane requires TUI mode`);
}

{
	const test = createContext({ availableProviders: ["openai", "anthropic", "openai"] });
	const harness = createRuntimeHarness({ loadConfigSyncConfig: defaultConfig(), showPaneResults: [{ action: "cancel" }] });

	harness.runtime.events.sessionStart({}, test.ctx);
	await harness.runtime.commands.openPane("", test.ctx);
	assert.equal(harness.showPaneInitials.length, 1, "TUI /glance should still open after provider-count snapshot setup");
	assert.equal(harness.showPanePreviewStates[0]?.providers.availableCount, 2, "showPane preview state should include current unique provider count");
	assertAmbientPaneOptions(harness.showPaneOptions[0], "provider-count snapshot pane open");
}

console.log("✓ runtime seam checks passed");
