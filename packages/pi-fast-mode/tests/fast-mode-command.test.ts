import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fastMode, {
	loadDefaultEnabled,
	STATUS_KEY,
	writeDefaultEnabled,
} from "../extensions/fast-mode.ts";

type RegisteredCommand = {
	handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
};

function createCtx(statuses: Array<string | undefined>, notifies: string[]) {
	return {
		model: { provider: "openai", id: "gpt-5.6", api: "openai-responses" },
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
			setStatus(key: string, value: string | undefined) {
				assert.equal(key, STATUS_KEY);
				statuses.push(value);
			},
			notify(message: string) {
				notifies.push(message);
			},
			onTerminalInput() {
				return () => {};
			},
		},
	} as unknown as ExtensionContext;
}

async function withLoadedExtension<T>(
	run: (input: {
		commands: Map<string, RegisteredCommand>;
		handlers: Map<string, (event: { reason?: string }, ctx: ExtensionContext) => void>;
	}) => Promise<T>,
): Promise<T> {
	const root = await mkdtemp(path.join(tmpdir(), "pi-fast-mode-cmd-"));
	const agentDir = path.join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const commands = new Map<string, RegisteredCommand>();
		const handlers = new Map<string, (event: { reason?: string }, ctx: ExtensionContext) => void>();
		const pi = {
			registerProvider() {},
			registerCommand(name: string, spec: RegisteredCommand) {
				commands.set(name, spec);
			},
			on(event: string, handler: (event: { reason?: string }, ctx: ExtensionContext) => void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		fastMode(pi);
		return await run({ commands, handlers });
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
}

test("/fast default writes settings and leaves the current switch unchanged", async () => {
	await withLoadedExtension(async ({ commands, handlers }) => {
		const statuses: Array<string | undefined> = [];
		const notifies: string[] = [];
		const ctx = createCtx(statuses, notifies);
		const command = commands.get("fast");
		const sessionStart = handlers.get("session_start");
		assert.ok(command);
		assert.ok(sessionStart);

		sessionStart({ reason: "startup" }, ctx);
		await command.handler("on", ctx);
		assert.match(String(statuses.at(-1)), /FAST/);

		statuses.length = 0;
		notifies.length = 0;
		await command.handler("default off", ctx);

		assert.equal(loadDefaultEnabled(), false);
		assert.match(String(statuses.at(-1)), /FAST/);
		assert.match(notifies.join("\n"), /Current switch is unchanged/);
	});
});

test("Ctrl+F consumes the key and keeps the repeat guard", async () => {
	await withLoadedExtension(async ({ handlers }) => {
		const statuses: Array<string | undefined> = [];
		const notifies: string[] = [];
		let inputHandler: ((data: string) => { consume: true } | undefined) | undefined;
		const ctx = {
			model: { provider: "openai", id: "gpt-5.6", api: "openai-responses" },
			ui: {
				theme: {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				},
				setStatus(key: string, value: string | undefined) {
					assert.equal(key, STATUS_KEY);
					statuses.push(value);
				},
				notify(message: string) {
					notifies.push(message);
				},
				onTerminalInput(handler: (data: string) => { consume: true } | undefined) {
					inputHandler = handler;
					return () => {
						inputHandler = undefined;
					};
				},
			},
		} as unknown as ExtensionContext;
		const sessionStart = handlers.get("session_start");
		assert.ok(sessionStart);

		sessionStart({ reason: "startup" }, ctx);
		assert.ok(inputHandler);
		assert.equal(inputHandler("x"), undefined);

		assert.deepEqual(inputHandler("\u0006"), { consume: true });
		assert.match(String(statuses.at(-1)), /FAST/);
		const afterFirst = statuses.at(-1);

		assert.deepEqual(inputHandler("\u0006"), { consume: true });
		assert.equal(statuses.at(-1), afterFirst);
	});
});

test("/new /resume /fork keep the current switch; /reload rereads settings", async () => {
	await withLoadedExtension(async ({ commands, handlers }) => {
		const statuses: Array<string | undefined> = [];
		const notifies: string[] = [];
		const ctx = createCtx(statuses, notifies);
		const command = commands.get("fast");
		const sessionStart = handlers.get("session_start");
		assert.ok(command);
		assert.ok(sessionStart);

		sessionStart({ reason: "startup" }, ctx);
		await command.handler("on", ctx);
		writeDefaultEnabled(false);

		for (const reason of ["new", "resume", "fork"] as const) {
			sessionStart({ reason }, ctx);
			assert.match(String(statuses.at(-1)), /FAST/, reason);
		}

		sessionStart({ reason: "reload" }, ctx);
		assert.match(String(statuses.at(-1)), /fast: off/);
		assert.equal(loadDefaultEnabled(), false);
	});
});
