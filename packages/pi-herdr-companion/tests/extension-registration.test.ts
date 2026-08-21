import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import extension from "../src/extension.ts";

const ENV_KEYS = [
	"HERDR_ENV",
	"HERDR_PANE_ID",
	"HERDR_TAB_ID",
	"HERDR_WORKSPACE_ID",
	"HERDR_SOCKET_PATH",
	"PI_HERDR_COMPANION_BTW_PAYLOAD",
	"PI_CODING_AGENT_DIR",
] as const;
const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];

afterEach(async () => {
	for (const key of ENV_KEYS) {
		const value = original[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakePi() {
	const tools: string[] = [];
	const commands: string[] = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
	const pi = {
		on(name: string, handler: (event: unknown, ctx: any) => unknown) {
			const values = handlers.get(name) ?? [];
			values.push(handler);
			handlers.set(name, values);
		},
		registerTool(tool: { name: string }) { tools.push(tool.name); },
		registerCommand(name: string) { commands.push(name); },
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		events: {
			on(name: string, handler: (data: unknown) => void) {
				const values = eventHandlers.get(name) ?? [];
				values.push(handler);
				eventHandlers.set(name, values);
				return () => undefined;
			},
			emit(name: string, data: unknown) {
				for (const handler of eventHandlers.get(name) ?? []) handler(data);
			},
		},
		exec: async (): Promise<ExecResult> => ({ stdout: '{"result":{"panes":[]}}', stderr: "", code: 0, killed: false }),
		getActiveTools: () => [],
		getAllTools: () => [],
		getThinkingLevel: () => "off",
		sendMessage() {},
		sendUserMessage() {},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	return { pi, tools, commands, handlers };
}

function sessionContext(mode: "tui" | "rpc" | "json" | "print") {
	const notifications: string[] = [];
	return {
		mode,
		notifications,
		ui: {
			notify(message: string) { notifications.push(message); },
			onTerminalInput() { return () => undefined; },
			getEditorText() { return ""; },
			async confirm() { return false; },
			setTitle() {},
			setWidget() {},
			setEditorText() {},
			theme: { fg: (_kind: string, value: string) => value },
		},
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "session-1",
			getEntries: () => [],
			getSessionFile: () => undefined,
		},
		isIdle: () => true,
	};
}

async function emitSnapshot(
	handlers: Map<string, Array<(event: unknown, ctx: any) => unknown>>,
	name: string,
	event: unknown,
	ctx: ReturnType<typeof sessionContext>,
): Promise<void> {
	for (const handler of [...(handlers.get(name) ?? [])]) await handler(event, ctx);
}

async function useIsolatedAgentDir(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "herdr-extension-gate-"));
	roots.push(root);
	process.env.PI_CODING_AGENT_DIR = root;
	return root;
}

function setUsableHerdrRuntime(): void {
	Object.assign(process.env, {
		HERDR_ENV: "1",
		HERDR_PANE_ID: "w1:p1",
		HERDR_TAB_ID: "w1:t1",
		HERDR_WORKSPACE_ID: "w1",
		HERDR_SOCKET_PATH: "/tmp/herdr.sock",
	});
	delete process.env.PI_HERDR_COMPANION_BTW_PAYLOAD;
}

describe.sequential("extension registration gates", () => {
	it("is a strict no-op outside Herdr", async () => {
		for (const key of ENV_KEYS) delete process.env[key];
		const h = fakePi();
		await extension(h.pi);
		expect(h.tools).toEqual([]);
		expect(h.commands).toEqual([]);
		expect(h.handlers.size).toBe(0);
	});

	it("is a strict no-op with incomplete Herdr caller identity", async () => {
		for (const key of ENV_KEYS) delete process.env[key];
		Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" });
		const h = fakePi();
		await extension(h.pi);
		expect(h.tools).toEqual([]);
		expect(h.commands).toEqual([]);
		expect(h.handlers.size).toBe(0);
	});

	it.each(["rpc", "json", "print"] as const)("activates mode-agnostic Herdr core in %s mode", async (mode) => {
		await useIsolatedAgentDir();
		setUsableHerdrRuntime();
		const h = fakePi();
		await extension(h.pi);
		expect([...h.handlers.keys()]).toEqual(["session_start"]);
		const ctx = sessionContext(mode);
		await emitSnapshot(h.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(h.tools).toEqual(["herdr_process"]);
		expect(h.commands).toEqual([]);
		expect(h.handlers.get("context")).toBeUndefined();
		expect(h.handlers.get("input")).toBeUndefined();
		const before = h.handlers.get("before_agent_start") ?? [];
		expect(before).toHaveLength(1);
		const result = await before[0]?.({ systemPrompt: "base" }, ctx) as { systemPrompt: string };
		expect(result).toMatchObject({ systemPrompt: expect.stringContaining("pane: w1:p1") });
		expect(result.systemPrompt).not.toContain("/btw");
		expect(result.systemPrompt).not.toContain("herdr_worker");
		expect(result.systemPrompt).not.toContain("[pi-herdr-worker-report:v1]");
		expect(ctx.notifications).toEqual([]);
		await emitSnapshot(h.handlers, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	});

	it("keeps parent-only BTW launch text out of a child current-session prompt", async () => {
		const root = await useIsolatedAgentDir();
		setUsableHerdrRuntime();
		process.env.PI_HERDR_COMPANION_BTW_PAYLOAD = join(root, "missing-child-payload.json");
		const h = fakePi();
		await extension(h.pi);
		const ctx = sessionContext("tui");
		await emitSnapshot(h.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

		let systemPrompt = "base";
		for (const handler of h.handlers.get("before_agent_start") ?? []) {
			const result = await handler({ systemPrompt }, ctx) as { systemPrompt?: string } | undefined;
			if (result?.systemPrompt) systemPrompt = result.systemPrompt;
		}
		expect(h.tools).toEqual(["herdr_process"]);
		expect(systemPrompt).toContain("pane: w1:p1");
		expect(systemPrompt).not.toContain("/btw");
		expect(systemPrompt).not.toContain("herdr_worker");
		expect(systemPrompt).not.toContain("[pi-herdr-worker-report:v1]");
		await emitSnapshot(h.handlers, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	});

	it("adds TUI-only commands and BTW registration alongside the Herdr core", async () => {
		await useIsolatedAgentDir();
		setUsableHerdrRuntime();
		const h = fakePi();
		await extension(h.pi);
		expect(h.tools).toEqual([]);
		expect(h.commands).toEqual([]);

		const ctx = sessionContext("tui");
		await emitSnapshot(h.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(h.tools).toEqual(["herdr_process"]);
		expect(h.commands).toEqual(expect.arrayContaining(["btw", "herdr-config", "herdr-worktree"]));
		expect(h.tools).not.toContain("btw");
		expect(h.tools).not.toContain("herdr_worker");
		expect(h.tools).not.toContain("herdr_blocked");
		expect(h.handlers.get("input")).toBeUndefined();

		const before = h.handlers.get("before_agent_start") ?? [];
		expect(before).toHaveLength(1);
		const result = await before[0]?.({ systemPrompt: "base" }, ctx) as { systemPrompt: string };
		expect(result).toMatchObject({ systemPrompt: expect.stringContaining("pane: w1:p1") });
		expect(result.systemPrompt).toContain("/btw");
		expect(result.systemPrompt).not.toContain("herdr_worker");
		expect(result.systemPrompt).not.toContain("[pi-herdr-worker-report:v1]");

		await emitSnapshot(h.handlers, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	});
});
