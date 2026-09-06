import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	applySetting,
	buildInspectorSettings,
	getToolDisplayArgumentCompletions,
	registerToolDisplayCommand,
} from "../src/config-modal.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";
import type { ToolDisplayCapabilities } from "../src/capabilities.ts";

interface Notification {
	message: string;
	level: string;
}

function createPiStub(): {
	api: ExtensionAPI;
	getName: () => string | undefined;
	getHandler: () => ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	getCompletions: () => ((prefix: string) => unknown) | undefined;
} {
	let name: string | undefined;
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	let completions: ((prefix: string) => unknown) | undefined;
	const api = {
		registerCommand(cmdName: string, cmd: {
			handler: typeof handler;
			getArgumentCompletions?: typeof completions;
		}) {
			name = cmdName;
			handler = cmd.handler;
			completions = cmd.getArgumentCompletions;
		},
	} as unknown as ExtensionAPI;
	return { api, getName: () => name, getHandler: () => handler, getCompletions: () => completions };
}

function createCtxStub(options?: {
	hasUI?: boolean;
	customFn?: () => Promise<void>;
	confirm?: boolean;
}): {
	ctx: ExtensionCommandContext;
	notifications: Notification[];
	reloadCount: { value: number };
} {
	const notifications: Notification[] = [];
	const reloadCount = { value: 0 };
	return {
		ctx: {
			hasUI: options?.hasUI ?? true,
			ui: {
				notify: (message: string, level: string): void => {
					notifications.push({ message, level });
				},
				custom: options?.customFn ?? (async (): Promise<void> => {}),
				confirm: async (): Promise<boolean> => options?.confirm ?? true,
			},
			reload: async (): Promise<void> => {
				reloadCount.value += 1;
			},
		} as unknown as ExtensionCommandContext,
		notifications,
		reloadCount,
	};
}

function createControllerStub(
	initialConfig?: Partial<ToolDisplayConfig>,
	capabilities?: ToolDisplayCapabilities,
): {
	controller: {
		getConfig: () => ToolDisplayConfig;
		setConfig: (
			next: ToolDisplayConfig,
			ctx: ExtensionCommandContext,
			options?: { skipReloadHint?: boolean },
		) => void;
		getCapabilities: () => ToolDisplayCapabilities;
	};
	getLastSet: () => {
		config: ToolDisplayConfig | null;
		ctx: ExtensionCommandContext | null;
		skipReloadHint?: boolean;
	};
} {
	let config: ToolDisplayConfig = {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		...initialConfig,
		registerToolOverrides: {
			...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
			...initialConfig?.registerToolOverrides,
		},
		toolIntent: {
			...DEFAULT_TOOL_DISPLAY_CONFIG.toolIntent,
			...initialConfig?.toolIntent,
		},
	};
	const last = {
		config: null as ToolDisplayConfig | null,
		ctx: null as ExtensionCommandContext | null,
		skipReloadHint: undefined as boolean | undefined,
	};
	return {
		controller: {
			getConfig: () => ({
				...config,
				registerToolOverrides: { ...config.registerToolOverrides },
				toolIntent: { ...config.toolIntent },
			}),
			setConfig: (next, ctx, options) => {
				config = next;
				last.config = next;
				last.ctx = ctx;
				last.skipReloadHint = options?.skipReloadHint;
			},
			getCapabilities: () => capabilities ?? { hasMcpTooling: false, hasRtkOptimizer: false },
		},
		getLastSet: () => last,
	};
}

test("registerToolDisplayCommand registers tools", () => {
	const { api, getName, getHandler, getCompletions } = createPiStub();
	registerToolDisplayCommand(api, createControllerStub().controller);
	assert.equal(getName(), "tools");
	assert.ok(getHandler());
	assert.ok(getCompletions());
});

test("/tools argument completions list layouts and filter by prefix", () => {
	assert.deepEqual(
		getToolDisplayArgumentCompletions("").map((item) => item.value),
		["aggregate", "individual"],
	);
	assert.deepEqual(
		getToolDisplayArgumentCompletions("a").map((item) => item.value),
		["aggregate"],
	);
	assert.deepEqual(
		getToolDisplayArgumentCompletions("layout in").map((item) => item.value),
		["individual"],
	);
});

test("/tools aggregate confirms, saves, and reloads", async () => {
	const { api, getHandler } = createPiStub();
	const { controller, getLastSet } = createControllerStub();
	const { ctx, notifications, reloadCount } = createCtxStub({ confirm: true });
	registerToolDisplayCommand(api, controller);
	await getHandler()!("aggregate", ctx);

	assert.equal(getLastSet().config?.toolCallLayout, "aggregate");
	assert.equal(getLastSet().skipReloadHint, true);
	assert.equal(reloadCount.value, 1);
	assert.equal(notifications.length, 0);
});

test("/tools layout individual uses the same confirm and reload path", async () => {
	const { api, getHandler } = createPiStub();
	const { controller, getLastSet } = createControllerStub({ toolCallLayout: "aggregate" });
	const { ctx, reloadCount } = createCtxStub({ confirm: true });
	registerToolDisplayCommand(api, controller);
	await getHandler()!("layout individual", ctx);

	assert.equal(getLastSet().config?.toolCallLayout, "individual");
	assert.equal(getLastSet().skipReloadHint, true);
	assert.equal(reloadCount.value, 1);
});

test("cancel leaves the previous layout and does not reload", async () => {
	const { api, getHandler } = createPiStub();
	const { controller, getLastSet } = createControllerStub();
	const { ctx, notifications, reloadCount } = createCtxStub({ confirm: false });
	registerToolDisplayCommand(api, controller);
	await getHandler()!("aggregate", ctx);

	assert.equal(getLastSet().config, null);
	assert.equal(controller.getConfig().toolCallLayout, "individual");
	assert.equal(reloadCount.value, 0);
	assert.match(notifications[0]?.message ?? "", /Layout unchanged/);
});

test("same layout notifies without saving or reloading", async () => {
	const { api, getHandler } = createPiStub();
	const { controller, getLastSet } = createControllerStub();
	const { ctx, notifications, reloadCount } = createCtxStub();
	registerToolDisplayCommand(api, controller);
	await getHandler()!("individual", ctx);

	assert.equal(getLastSet().config, null);
	assert.equal(reloadCount.value, 0);
	assert.match(notifications[0]?.message ?? "", /already individual/);
});

test("unknown layout warns without saving", async () => {
	const { api, getHandler } = createPiStub();
	const { controller, getLastSet } = createControllerStub();
	const { ctx, notifications, reloadCount } = createCtxStub();
	registerToolDisplayCommand(api, controller);
	await getHandler()!("layout combined", ctx);

	assert.equal(getLastSet().config, null);
	assert.equal(reloadCount.value, 0);
	assert.match(notifications[0]?.message ?? "", /Usage: \/tools \[individual\|aggregate\]/);
});

test("dropped slash subcommands show usage without mutating config", async () => {
	const commands = ["show", "reset", "mode summary", "preset compact"] as const;
	for (const command of commands) {
		const { api, getHandler } = createPiStub();
		const { controller, getLastSet } = createControllerStub();
		const { ctx, notifications, reloadCount } = createCtxStub();
		registerToolDisplayCommand(api, controller);
		await getHandler()!(command, ctx);
		assert.equal(getLastSet().config, null, command);
		assert.equal(reloadCount.value, 0, command);
		assert.match(notifications[0]?.message ?? "", /Usage: \/tools \[individual\|aggregate\]/);
	}
});

test("aggregate modal exposes global diff settings and hides individual-only settings without deleting retained values", () => {
	const retained = {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		toolCallLayout: "aggregate" as const,
		showContextGrowth: true,
		resultMode: "preview" as const,
		previewRows: 40,
		bashCommandPreviewRows: 4,
		diffViewMode: "split" as const,
		diffIndicatorMode: "classic" as const,
		diffCollapsedMode: "summary" as const,
		diffCollapsedRows: 12,
		diffSplitMinWidth: 144,
		diffWordWrap: false,
		toolIntent: { language: "zh-CN" as const, maxLength: 64 },
	};
	const original = structuredClone(retained);
	const aggregateSettings = buildInspectorSettings(retained, {
		hasMcpTooling: false,
		hasRtkOptimizer: false,
	});
	assert.deepEqual(
		aggregateSettings.map((setting) => setting.id),
		["toolCallLayout", "toolIntentLanguage", "expandedTimeline", "showContextGrowth", "diffViewMode", "diffIndicatorMode"],
	);
	assert.deepEqual(retained, original);
	assert.equal(aggregateSettings.find((setting) => setting.id === "diffViewMode")?.currentValue, "split");
	assert.equal(aggregateSettings.find((setting) => setting.id === "diffIndicatorMode")?.currentValue, "classic");
	const intentLanguageSetting = aggregateSettings.find((setting) => setting.id === "toolIntentLanguage");
	assert.equal(intentLanguageSetting?.currentValue, "zh-CN");
	assert.deepEqual(intentLanguageSetting?.values, ["auto", "zh-CN", "en"]);
	assert.match(intentLanguageSetting?.inspectorSummary.join(" ") ?? "", /does not detect or enforce/);
	const englishIntent = applySetting(retained, "toolIntentLanguage", "en");
	assert.equal(englishIntent.toolIntent.language, "en");
	assert.equal(englishIntent.toolIntent.maxLength, 64);
	assert.equal(applySetting(retained, "expandedTimeline", "turns").expandedTimeline, "turns");
	const layoutSummary = aggregateSettings[0]?.inspectorSummary.join(" ") ?? "";
	assert.match(layoutSummary, /bounded Run summary for every registered tool/);
	assert.match(layoutSummary, /successful rows stay done until replacement/);
	assert.match(layoutSummary, /Collapsed errors stay as a failed count/);
	assert.match(layoutSummary, /restores mid-turn narration in place/);
	assert.match(layoutSummary, /one target\/status summary per call/);
	assert.match(layoutSummary, /Agent keeps its original renderer by default/);
	assert.match(layoutSummary, /retained but inactive/);

	const individual = applySetting(retained, "toolCallLayout", "individual");
	assert.deepEqual(individual, { ...original, toolCallLayout: "individual" });
	const individualSettings = buildInspectorSettings(individual, {
		hasMcpTooling: false,
		hasRtkOptimizer: false,
	});
	assert.equal(individualSettings.find((setting) => setting.id === "diffViewMode")?.currentValue, "split");
	assert.equal(individualSettings.find((setting) => setting.id === "diffIndicatorMode")?.currentValue, "classic");
	assert.equal(individualSettings.find((setting) => setting.id === "diffCollapsedMode")?.currentValue, "summary");
	assert.ok(individualSettings.some((setting) => setting.id === "toolIntentLanguage"));
	assert.equal(individualSettings.some((setting) => setting.id === "expandedTimeline"), false);
	assert.equal(individualSettings.some((setting) => setting.id === "showContextGrowth"), false);
});

test("diff preferences selected in aggregate stay global across layout switches without resetting advanced or hidden settings", () => {
	const config: ToolDisplayConfig = {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		toolCallLayout: "aggregate",
		resultMode: "preview",
		previewRows: 40,
		bashCommandPreviewRows: 4,
		diffCollapsedMode: "summary",
		diffCollapsedRows: 12,
		diffSplitMinWidth: 144,
		diffWordWrap: false,
	};
	const original = structuredClone(config);
	const capabilities = { hasMcpTooling: false, hasRtkOptimizer: false };
	const aggregateSettings = buildInspectorSettings(config, capabilities);
	assert.deepEqual(aggregateSettings.find((setting) => setting.id === "diffViewMode")?.values, ["auto", "split", "unified"]);
	assert.deepEqual(aggregateSettings.find((setting) => setting.id === "diffIndicatorMode")?.values, ["bars", "classic", "none"]);

	const updated = applySetting(applySetting(config, "diffViewMode", "unified"), "diffIndicatorMode", "none");
	const individual = applySetting(updated, "toolCallLayout", "individual");
	const returned = applySetting(individual, "toolCallLayout", "aggregate");
	for (const candidate of [updated, individual, returned]) {
		const settings = buildInspectorSettings(candidate, capabilities);
		assert.equal(settings.find((setting) => setting.id === "diffViewMode")?.currentValue, "unified");
		assert.equal(settings.find((setting) => setting.id === "diffIndicatorMode")?.currentValue, "none");
		assert.deepEqual(candidate, {
			...original,
			toolCallLayout: candidate.toolCallLayout,
			diffViewMode: "unified",
			diffIndicatorMode: "none",
		});
	}
	assert.deepEqual(config, original);
});

for (const expandedTimeline of ["flat", "turns"] as const) {
	test(`context growth toggles in the ${expandedTimeline} aggregate timeline without changing other settings`, () => {
		const config: ToolDisplayConfig = {
			...DEFAULT_TOOL_DISPLAY_CONFIG,
			toolCallLayout: "aggregate",
			expandedTimeline,
			resultMode: "preview",
			previewRows: 40,
			bashCommandPreviewRows: 4,
			diffCollapsedMode: "summary",
			toolIntent: { language: "zh-CN", maxLength: 64 },
			passthroughToolNames: ["Agent", "custom_ui"],
			customToolOverrides: { web_search: { kind: "generic", outputMode: "summary" } },
		};
		const original = structuredClone(config);
		const capabilities = { hasMcpTooling: false, hasRtkOptimizer: false };
		const setting = buildInspectorSettings(config, capabilities).find((item) => item.id === "showContextGrowth");
		assert.equal(setting?.label, "Context growth");
		assert.equal(setting?.currentValue, "off");
		assert.deepEqual(setting?.values, ["off", "on"]);

		const enabled = applySetting(config, "showContextGrowth", "on");
		assert.deepEqual(enabled, { ...original, showContextGrowth: true });
		assert.deepEqual(config, original);
		assert.equal(
			buildInspectorSettings(enabled, capabilities).find((item) => item.id === "showContextGrowth")?.currentValue,
			"on",
		);
		assert.deepEqual(applySetting(enabled, "showContextGrowth", "off"), original);
		assert.equal(enabled.showContextGrowth, true);
	});
}

test("empty args opens the modal in TUI mode", async () => {
	const { api, getHandler } = createPiStub();
	let customCalled = false;
	const { ctx, notifications } = createCtxStub({
		customFn: async () => {
			customCalled = true;
		},
	});
	registerToolDisplayCommand(api, createControllerStub().controller);
	await getHandler()!("", ctx);
	assert.equal(customCalled, true);
	assert.equal(notifications.length, 0);
});

test("empty args without TUI warns", async () => {
	const { api, getHandler } = createPiStub();
	const { ctx, notifications } = createCtxStub({ hasUI: false });
	registerToolDisplayCommand(api, createControllerStub().controller);
	await getHandler()!("", ctx);
	assert.match(notifications[0]?.message ?? "", /\/tools requires interactive TUI mode/i);
});

test("unknown command shows layout usage", async () => {
	const { api, getHandler } = createPiStub();
	const { ctx, notifications } = createCtxStub();
	registerToolDisplayCommand(api, createControllerStub().controller);
	await getHandler()!("foobar", ctx);
	assert.match(notifications[0]?.message ?? "", /Usage: \/tools \[individual\|aggregate\]/);
});

test("modal rejection propagates", async () => {
	const { api, getHandler } = createPiStub();
	const { ctx } = createCtxStub({
		customFn: async () => {
			throw new Error("modal rejected");
		},
	});
	registerToolDisplayCommand(api, createControllerStub().controller);
	await assert.rejects(() => getHandler()!("", ctx), /modal rejected/);
});
