import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerToolDisplayCommand } from "../src/config-modal.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";
import type { ToolDisplayCapabilities } from "../src/capabilities.ts";

interface Notification {
	message: string;
	level: string;
}

function createPiStub(): {
	api: ExtensionAPI;
	getHandler: () => ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
} {
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const api = {
		registerCommand(_name: string, cmd: { handler: typeof handler }) {
			handler = cmd.handler;
		},
	} as unknown as ExtensionAPI;
	return { api, getHandler: () => handler };
}

function createCtxStub(
	hasUI: boolean,
	customFn?: () => Promise<void>,
): { ctx: ExtensionCommandContext; notifications: Notification[] } {
	const notifications: Notification[] = [];
	return {
		ctx: {
			hasUI,
			ui: {
				notify: (message: string, level: string): void => {
					notifications.push({ message, level });
				},
				custom: customFn ?? (async (): Promise<void> => {}),
			},
		} as unknown as ExtensionCommandContext,
		notifications,
	};
}

function createControllerStub(
	initialConfig?: Partial<ToolDisplayConfig>,
	capabilities?: ToolDisplayCapabilities,
): {
	controller: {
		getConfig: () => ToolDisplayConfig;
		setConfig: (next: ToolDisplayConfig, ctx: ExtensionCommandContext) => void;
		getCapabilities: () => ToolDisplayCapabilities;
	};
	getLastSet: () => { config: ToolDisplayConfig | null; ctx: ExtensionCommandContext | null };
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
	const last = { config: null as ToolDisplayConfig | null, ctx: null as ExtensionCommandContext | null };
	return {
		controller: {
			getConfig: () => ({
				...config,
				registerToolOverrides: { ...config.registerToolOverrides },
				toolIntent: { ...config.toolIntent },
			}),
			setConfig: (next, ctx) => {
				config = next;
				last.config = next;
				last.ctx = ctx;
			},
			getCapabilities: () => capabilities ?? { hasMcpTooling: false, hasRtkOptimizer: false },
		},
		getLastSet: () => last,
	};
}

test("registerToolDisplayCommand registers tool-display-intent", () => {
	const { api, getHandler } = createPiStub();
	registerToolDisplayCommand(api, createControllerStub().controller);
	assert.ok(getHandler());
});

test("show reports the simple result mode and independent groups", async () => {
	const { api, getHandler } = createPiStub();
	const { controller } = createControllerStub({}, { hasMcpTooling: true, hasRtkOptimizer: true });
	const { ctx, notifications } = createCtxStub(true);
	registerToolDisplayCommand(api, controller);
	await getHandler()!("show", ctx);

	assert.equal(notifications.length, 1);
	assert.match(notifications[0]?.message ?? "", /^tool-display-intent: /);
	assert.match(notifications[0]?.message ?? "", /results=compact\/8rows/);
	assert.match(notifications[0]?.message ?? "", /intent=on\/auto/);
	assert.match(notifications[0]?.message ?? "", /mcp=available/);
	assert.match(notifications[0]?.message ?? "", /rtkHints=off/);
	assert.equal(notifications[0]?.message.includes("profile"), false);
});

test("show reports unavailable optional capabilities", async () => {
	const { api, getHandler } = createPiStub();
	const { ctx, notifications } = createCtxStub(true);
	registerToolDisplayCommand(api, createControllerStub().controller);
	await getHandler()!("show", ctx);
	assert.match(notifications[0]?.message ?? "", /mcp=unavailable/);
	assert.match(notifications[0]?.message ?? "", /rtkHints=unavailable/);
});

test("reset restores the complete default config", async () => {
	const { api, getHandler } = createPiStub();
	const { controller, getLastSet } = createControllerStub({
		resultMode: "preview",
		readOutputMode: "preview",
		searchOutputMode: "preview",
		mcpOutputMode: "preview",
		previewRows: 40,
		toolCallStyle: "claude",
		toolIntent: { enabled: false, language: "zh-CN", maxLength: 64 },
		diffViewMode: "split",
	});
	const { ctx, notifications } = createCtxStub(true);
	registerToolDisplayCommand(api, controller);
	await getHandler()!("reset", ctx);
	assert.deepEqual(getLastSet().config, DEFAULT_TOOL_DISPLAY_CONFIG);
	assert.match(notifications[0]?.message ?? "", /reset to defaults/i);
});

test("mode summary changes only result shape and preserves previewRows", async () => {
	const { api, getHandler } = createPiStub();
	const { controller, getLastSet } = createControllerStub({
		previewRows: 20,
		toolCallStyle: "claude",
		toolIntent: { enabled: true, language: "zh-CN", maxLength: 64 },
		diffViewMode: "split",
		diffWordWrap: false,
		enableNativeUserMessageBox: false,
	});
	const { ctx, notifications } = createCtxStub(true);
	registerToolDisplayCommand(api, controller);
	await getHandler()!("mode summary", ctx);

	const config = getLastSet().config!;
	assert.equal(config.resultMode, "summary");
	assert.equal(config.readOutputMode, "summary");
	assert.equal(config.searchOutputMode, "count");
	assert.equal(config.mcpOutputMode, "summary");
	assert.equal(config.bashOutputMode, "summary");
	assert.equal(config.previewRows, 20);
	assert.equal(config.toolCallStyle, "claude");
	assert.equal(config.diffViewMode, "split");
	assert.equal(config.diffWordWrap, false);
	assert.equal(config.enableNativeUserMessageBox, false);
	assert.match(notifications[0]?.message ?? "", /result mode set to summary/i);
});

test("legacy preset aliases map to final result modes", async () => {
	const aliases = [
		["preset verbose", "preview"],
		["preset balanced", "summary"],
		["preset opencode", "compact"],
	] as const;
	for (const [command, expected] of aliases) {
		const { api, getHandler } = createPiStub();
		const { controller, getLastSet } = createControllerStub();
		const { ctx } = createCtxStub(true);
		registerToolDisplayCommand(api, controller);
		await getHandler()!(command, ctx);
		assert.equal(getLastSet().config?.resultMode, expected);
	}
});

test("invalid result mode warns without saving", async () => {
	const { api, getHandler } = createPiStub();
	const { controller, getLastSet } = createControllerStub();
	const { ctx, notifications } = createCtxStub(true);
	registerToolDisplayCommand(api, controller);
	await getHandler()!("mode turbo", ctx);
	assert.equal(getLastSet().config, null);
	assert.match(notifications[0]?.message ?? "", /unknown result mode/i);
	assert.equal(notifications[0]?.level, "warning");
});

test("empty args opens the modal in TUI mode", async () => {
	const { api, getHandler } = createPiStub();
	let customCalled = false;
	const { ctx, notifications } = createCtxStub(true, async () => {
		customCalled = true;
	});
	registerToolDisplayCommand(api, createControllerStub().controller);
	await getHandler()!("", ctx);
	assert.equal(customCalled, true);
	assert.equal(notifications.length, 0);
});

test("empty args without TUI warns", async () => {
	const { api, getHandler } = createPiStub();
	const { ctx, notifications } = createCtxStub(false);
	registerToolDisplayCommand(api, createControllerStub().controller);
	await getHandler()!("", ctx);
	assert.match(notifications[0]?.message ?? "", /interactive TUI mode/i);
});

test("unknown command shows mode-based usage", async () => {
	const { api, getHandler } = createPiStub();
	const { ctx, notifications } = createCtxStub(true);
	registerToolDisplayCommand(api, createControllerStub().controller);
	await getHandler()!("foobar", ctx);
	assert.match(notifications[0]?.message ?? "", /mode compact\|summary\|preview/i);
});

test("modal rejection propagates", async () => {
	const { api, getHandler } = createPiStub();
	const { ctx } = createCtxStub(true, async () => {
		throw new Error("modal rejected");
	});
	registerToolDisplayCommand(api, createControllerStub().controller);
	await assert.rejects(() => getHandler()!("", ctx), /modal rejected/);
});
