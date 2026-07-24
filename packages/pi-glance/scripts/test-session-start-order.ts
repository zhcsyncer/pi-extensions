import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type CapturedHandler = (event: unknown, ctx: ExtensionContext) => unknown;

interface CapturedPi {
	api: ExtensionAPI;
	handlers: Map<string, CapturedHandler>;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

function createPi(): CapturedPi {
	const handlers = new Map<string, CapturedHandler>();
	const api = {
		on: (event: string, handler: CapturedHandler) => {
			handlers.set(event, handler);
		},
		registerCommand: () => undefined,
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;
	return { api, handlers };
}

function getHandler(pi: CapturedPi, event: string): CapturedHandler {
	const handler = pi.handlers.get(event);
	assert.ok(handler, `expected ${event} handler to be registered`);
	return handler;
}

function createContext(calls: string[], mode: "tui" | "rpc" | "json" | "print" = "tui"): ExtensionContext {
	return {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
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
			setFooter: (factory: unknown) => calls.push(factory ? "setFooter:install" : "setFooter:clear"),
			setEditorComponent: (factory: unknown) => calls.push(factory ? "setEditorComponent:install" : "setEditorComponent:clear"),
		},
		getContextUsage: () => ({ tokens: 0, contextWindow: 200_000, percent: 0 }),
	} as unknown as ExtensionContext;
}

async function main(): Promise<void> {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await mkdtemp(join(tmpdir(), "pi-glance-session-start-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		// CONFIG_PATH is computed when config.js is imported, so import pi-glance only
		// after pointing pi at the isolated test agent directory.
		const { default: piGlance } = (await import(`../index.js?session-start-order=${process.pid}-${Date.now()}`)) as {
			default: (pi: ExtensionAPI) => void;
		};

		const enabledPi = createPi();
		piGlance(enabledPi.api);
		const enabledCalls: string[] = [];
		const enabledContext = createContext(enabledCalls);
		const enabledResult = getHandler(enabledPi, "session_start")({ type: "session_start" }, enabledContext);

		assert.equal(isPromiseLike(enabledResult), false, "session_start should be synchronous for default enabled config");
		assert.equal(enabledCalls[0], "setFooter:install", "default enabled TUI config should synchronously claim the footer before handler returns");
		assert.equal(enabledCalls[1], "setEditorComponent:install", "default enabled TUI config should synchronously claim the editor before handler returns");

		await getHandler(enabledPi, "session_shutdown")({ type: "session_shutdown" }, enabledContext);

		for (const mode of ["rpc", "json", "print"] as const) {
			const nonTuiPi = createPi();
			piGlance(nonTuiPi.api);
			const nonTuiCalls: string[] = [];
			const nonTuiResult = getHandler(nonTuiPi, "session_start")({ type: "session_start" }, createContext(nonTuiCalls, mode));
			assert.equal(isPromiseLike(nonTuiResult), false, `${mode} session_start should stay synchronous for default enabled config`);
			assert.deepEqual(nonTuiCalls, [], `${mode} session_start should not install or clear TUI footer/editor`);
		}

		await mkdir(join(agentDir, "pi-glance"), { recursive: true });
		await writeFile(join(agentDir, "pi-glance", "config.json"), `${JSON.stringify({ enabled: false })}\n`, "utf8");

		const disabledPi = createPi();
		piGlance(disabledPi.api);
		const disabledCalls: string[] = [];
		const disabledResult = getHandler(disabledPi, "session_start")({ type: "session_start" }, createContext(disabledCalls));

		assert.equal(isPromiseLike(disabledResult), false, "session_start should also be synchronous for disabled config");
		assert.deepEqual(disabledCalls.filter((call) => call.endsWith(":install")), [], "disabled config should not claim custom footer/editor");
		assert.ok(disabledCalls.includes("setEditorComponent:clear"), "disabled config should synchronously restore the built-in editor");
		assert.ok(disabledCalls.includes("setFooter:clear"), "disabled config should synchronously restore the built-in footer");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
}

await main();
console.log("✓ session_start synchronous input-surface claim checks passed");
