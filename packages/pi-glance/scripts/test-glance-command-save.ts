import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GlanceConfig } from "../types.js";

type PaneResult = { action: "save"; config: GlanceConfig } | { action: "cancel" };
type CapturedHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;

interface Notification {
	message: string;
	type: "info" | "warning" | "error" | undefined;
}

interface CapturedPi {
	api: ExtensionAPI;
	handlers: Map<string, CapturedHandler>;
	commands: Map<string, CommandHandler>;
}

interface TestContext {
	ctx: ExtensionCommandContext;
	notifications: Notification[];
	surfaceCalls: string[];
	customResults: PaneResult[];
	renderedPanes: string[][];
}

function createPi(): CapturedPi {
	const handlers = new Map<string, CapturedHandler>();
	const commands = new Map<string, CommandHandler>();
	const api = {
		on: (event: string, handler: CapturedHandler) => {
			handlers.set(event, handler);
		},
		registerCommand: (name: string, options: { handler: CommandHandler }) => {
			commands.set(name, options.handler);
		},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;
	return { api, handlers, commands };
}

function getHandler(pi: CapturedPi, event: string): CapturedHandler {
	const handler = pi.handlers.get(event);
	assert.ok(handler, `expected ${event} handler to be registered`);
	return handler;
}

function getCommand(pi: CapturedPi, name: string): CommandHandler {
	const command = pi.commands.get(name);
	assert.ok(command, `expected ${name} command to be registered`);
	return command;
}

function createContext(customResults: PaneResult[]): TestContext {
	const notifications: Notification[] = [];
	const surfaceCalls: string[] = [];
	const renderedPanes: string[][] = [];
	const fakeTui = { requestRender: () => undefined };
	const fakeTheme = { fg: (_tone: string, text: string) => text };

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		model: { id: "test-model", provider: "test-provider", contextWindow: 200_000 },
		modelRegistry: {
			getAvailable: () => [{ provider: "test-provider", id: "test-model" }],
		},
		sessionManager: {
			getCwd: () => process.cwd(),
			getEntries: () => [],
			getBranch: () => [],
		},
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => {
				notifications.push({ message, type });
			},
			custom: async <T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => { render?: (width: number) => string[] }) => {
				const component = factory(fakeTui, fakeTheme, {}, () => undefined);
				if (typeof component.render === "function") renderedPanes.push(component.render(100));
				const result = customResults.shift();
				assert.ok(result, "expected queued custom pane result");
				return result as T;
			},
			setFooter: (factory: unknown) => surfaceCalls.push(factory ? "setFooter:install" : "setFooter:clear"),
			setEditorComponent: (factory: unknown) => surfaceCalls.push(factory ? "setEditorComponent:install" : "setEditorComponent:clear"),
		},
		getContextUsage: () => ({ tokens: 0, contextWindow: 200_000, percent: 0 }),
	} as unknown as ExtensionCommandContext;

	return { ctx, notifications, surfaceCalls, customResults, renderedPanes };
}

function cloneConfig(config: GlanceConfig): GlanceConfig {
	return JSON.parse(JSON.stringify(config)) as GlanceConfig;
}

function disabled(config: GlanceConfig): GlanceConfig {
	const next = cloneConfig(config);
	next.enabled = false;
	return next;
}

function hasNotification(notifications: Notification[], message: string, type: Notification["type"]): boolean {
	return notifications.some((notification) => notification.message === message && notification.type === type);
}

function assertNoNewSurfaceCalls(surfaceCalls: string[], baseline: number, message: string): void {
	assert.deepEqual(surfaceCalls.slice(baseline), [], message);
}

async function main(): Promise<void> {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await mkdtemp(join(tmpdir(), "pi-glance-command-save-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const configDir = join(agentDir, "pi-glance");
		const configPath = join(configDir, "config.json");
		const { configToText, defaultConfig } = await import("../config.js");
		const initialConfig = defaultConfig();
		await mkdir(configDir, { recursive: true });
		await writeFile(configPath, configToText(initialConfig), "utf8");

		const { default: piGlance } = (await import(`../index.js?command-save=${process.pid}-${Date.now()}`)) as {
			default: (pi: ExtensionAPI) => void;
		};

		const pi = createPi();
		piGlance(pi.api);
		const test = createContext([]);
		getHandler(pi, "session_start")({ type: "session_start" }, test.ctx);
		assert.deepEqual(test.surfaceCalls, ["setFooter:install", "setEditorComponent:install"], "enabled session_start should install the input surface");

		const command = getCommand(pi, "glance");
		await rm(configDir, { recursive: true, force: true });
		await writeFile(configDir, "not a directory", "utf8");

		test.customResults.push({ action: "save", config: disabled(initialConfig) });
		const failureBaseline = test.surfaceCalls.length;
		await command("", test.ctx);
		assert.equal(
			hasNotification(test.notifications, "pi-glance configuration save failed; keeping previous configuration", "error"),
			true,
			"save failure should notify an error",
		);
		assert.equal(hasNotification(test.notifications, "pi-glance configuration saved", "info"), false, "save failure should not notify success");
		assertNoNewSurfaceCalls(test.surfaceCalls, failureBaseline, "save failure should not refresh or reinstall/clear the input surface");

		test.customResults.push({ action: "cancel" });
		await command("", test.ctx);
		const activeConfigPane = test.renderedPanes.at(-1)?.join("\n") ?? "";
		assert.match(activeConfigPane, /Enabled\s+on/, "after failed save, the next /glance pane should still receive the previous enabled config");

		await rm(configDir, { force: true });
		await mkdir(configDir, { recursive: true });
		const successBaseline = test.surfaceCalls.length;
		test.customResults.push({ action: "save", config: disabled(initialConfig) });
		await command("", test.ctx);
		assert.equal(JSON.parse(await readFile(configPath, "utf8")).enabled, false, "successful save should write next config to disk");
		assert.equal(hasNotification(test.notifications, "pi-glance configuration saved", "info"), true, "successful save should notify success");
		assert.deepEqual(
			test.surfaceCalls.slice(successBaseline),
			["setEditorComponent:clear", "setFooter:clear"],
			"successful save of disabled config should clear the custom input surface after disk write succeeds",
		);

		await rm(configDir, { recursive: true, force: true });
		await writeFile(configDir, "not a directory", "utf8");
		const cancelBaseline = test.surfaceCalls.length;
		const notificationsBeforeCancel = test.notifications.length;
		test.customResults.push({ action: "cancel" });
		await command("", test.ctx);
		const disabledActivePane = test.renderedPanes.at(-1)?.join("\n") ?? "";
		assert.match(disabledActivePane, /Enabled\s+off/, "after successful disabled save, the next /glance pane should receive disabled active config");
		assert.equal(hasNotification(test.notifications.slice(notificationsBeforeCancel), "pi-glance configuration cancelled", "info"), true, "cancel should keep the existing cancellation notice");
		assert.equal(
			hasNotification(test.notifications.slice(notificationsBeforeCancel), "pi-glance configuration save failed; keeping previous configuration", "error"),
			false,
			"cancel should not attempt to save even when the config path is blocked",
		);
		assertNoNewSurfaceCalls(test.surfaceCalls, cancelBaseline, "cancel should not refresh or reinstall/clear the input surface");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
}

await main();
console.log("✓ /glance command save failure checks passed");
