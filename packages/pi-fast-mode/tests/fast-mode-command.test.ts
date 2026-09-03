import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fastMode, {
	footerStatusLabel,
	loadDefaultEnabled,
	resolveSettingsPath,
	SHORTCUT_REPEAT_GUARD_MS,
	STATUS_KEY,
	writeDefaultEnabled,
} from "../extensions/fast-mode.ts";

type RegisteredCommand = {
	handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
};

type RegisteredProvider = {
	api?: string;
	streamSimple?: (...args: never[]) => unknown;
};

type EventHandler = (event: { reason?: string; payload?: unknown }, ctx: ExtensionContext) => unknown;

const KITTY_CTRL_F_RELEASE = "\x1b[102;5:3u";
const GPT = {
	provider: "openai",
	id: "gpt-5.6",
	api: "openai-responses",
} as const;
const GROK = {
	provider: "xai",
	id: "grok-4.6",
	api: "openai-responses",
} as const;
const CLAUDE = {
	provider: "anthropic",
	id: "claude-opus-4-6",
	api: "anthropic-messages",
} as const;

function setCtxModel(
	ctx: ExtensionContext,
	model: { provider: string; id: string; api: string },
): void {
	(ctx as unknown as { model: { provider: string; id: string; api: string } }).model = model;
}

function createCtx(
	statuses: Array<string | undefined>,
	notifies: string[],
	model: { provider: string; id: string; api: string } = GPT,
) {
	return {
		model,
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

function createInputCtx(statuses: Array<string | undefined>, notifies: string[]) {
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
	return {
		ctx,
		handle(data: string) {
			assert.ok(inputHandler);
			return inputHandler(data);
		},
	};
}

async function withLoadedExtension<T>(
	run: (input: {
		commands: Map<string, RegisteredCommand>;
		handlers: Map<string, EventHandler>;
		providers: Map<string, RegisteredProvider>;
	}) => Promise<T>,
): Promise<T> {
	const root = await mkdtemp(path.join(tmpdir(), "pi-fast-mode-cmd-"));
	const agentDir = path.join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const commands = new Map<string, RegisteredCommand>();
		const handlers = new Map<string, EventHandler>();
		const providers = new Map<string, RegisteredProvider>();
		const pi = {
			registerProvider(name: string, spec: RegisteredProvider) {
				providers.set(name, spec);
			},
			registerCommand(name: string, spec: RegisteredCommand) {
				commands.set(name, spec);
			},
			on(event: string, handler: EventHandler) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		fastMode(pi);
		return await run({ commands, handlers, providers });
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
}

test("registers built-in xAI on the Responses wrapper", async () => {
	await withLoadedExtension(async ({ providers }) => {
		const xai = providers.get("xai");
		assert.equal(xai?.api, "openai-responses");
		assert.equal(typeof xai?.streamSimple, "function");
	});
});

test("/fast default writes this model's setting and leaves the current switch unchanged", async () => {
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
		assert.equal(statuses.at(-1), footerStatusLabel(true, true));

		statuses.length = 0;
		notifies.length = 0;
		await command.handler("default off", ctx);

		assert.equal(loadDefaultEnabled("openai/gpt-5.6"), false);
		assert.equal(statuses.at(-1), footerStatusLabel(true, true));
		assert.match(notifies.join("\n"), /openai\/gpt-5\.6/);
		assert.match(notifies.join("\n"), /Current switch is unchanged/);

		statuses.length = 0;
		notifies.length = 0;
		await command.handler("default on", ctx);
		assert.equal(loadDefaultEnabled("openai/gpt-5.6"), true);
		assert.equal(loadDefaultEnabled("xai/grok-4.6"), false);
		assert.equal(statuses.at(-1), footerStatusLabel(true, true));
	});
});

test("Ctrl+F consumes the key and keeps the repeat guard", async () => {
	await withLoadedExtension(async ({ handlers }) => {
		const statuses: Array<string | undefined> = [];
		const notifies: string[] = [];
		const { ctx, handle } = createInputCtx(statuses, notifies);
		const sessionStart = handlers.get("session_start");
		assert.ok(sessionStart);

		sessionStart({ reason: "startup" }, ctx);
		assert.equal(handle("x"), undefined);

		assert.deepEqual(handle("\u0006"), { consume: true });
		assert.equal(statuses.at(-1), footerStatusLabel(true, true));
		assert.equal(notifies.length, 0);
		const afterFirst = statuses.at(-1);

		assert.deepEqual(handle("\u0006"), { consume: true });
		assert.equal(statuses.at(-1), afterFirst);
		assert.equal(notifies.length, 0);
	});
});

test("Kitty Ctrl+F release is consumed and does not toggle", async () => {
	await withLoadedExtension(async ({ handlers }) => {
		const statuses: Array<string | undefined> = [];
		const notifies: string[] = [];
		const { ctx, handle } = createInputCtx(statuses, notifies);
		const sessionStart = handlers.get("session_start");
		assert.ok(sessionStart);

		sessionStart({ reason: "startup" }, ctx);
		assert.deepEqual(handle("\u0006"), { consume: true });
		assert.equal(statuses.at(-1), footerStatusLabel(true, true));
		assert.equal(notifies.length, 0);
		const afterPress = statuses.at(-1);

		assert.deepEqual(handle(KITTY_CTRL_F_RELEASE), { consume: true });
		assert.equal(statuses.at(-1), afterPress);
		assert.equal(notifies.length, 0);
	});
});

test("Kitty Ctrl+F release after the repeat guard expires still does not toggle", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	await withLoadedExtension(async ({ handlers }) => {
		const statuses: Array<string | undefined> = [];
		const notifies: string[] = [];
		const { ctx, handle } = createInputCtx(statuses, notifies);
		const sessionStart = handlers.get("session_start");
		assert.ok(sessionStart);

		sessionStart({ reason: "startup" }, ctx);
		assert.deepEqual(handle("\u0006"), { consume: true });
		assert.equal(statuses.at(-1), footerStatusLabel(true, true));
		assert.equal(notifies.length, 0);
		const afterPress = statuses.at(-1);

		t.mock.timers.tick(SHORTCUT_REPEAT_GUARD_MS);
		assert.deepEqual(handle(KITTY_CTRL_F_RELEASE), { consume: true });
		assert.equal(statuses.at(-1), afterPress);
		assert.equal(notifies.length, 0);
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
		assert.equal(notifies.length, 0);
		writeDefaultEnabled("openai/gpt-5.6", false);

		for (const reason of ["new", "resume", "fork"] as const) {
			sessionStart({ reason }, ctx);
			assert.equal(statuses.at(-1), footerStatusLabel(true, true), reason);
		}

		sessionStart({ reason: "reload" }, ctx);
		assert.equal(statuses.at(-1), footerStatusLabel(false, true));
		assert.equal(loadDefaultEnabled("openai/gpt-5.6"), false);
	});
});

test("/fast toggle updates the footer without a transcript notify", async () => {
	await withLoadedExtension(async ({ commands, handlers }) => {
		const statuses: Array<string | undefined> = [];
		const notifies: string[] = [];
		const ctx = createCtx(statuses, notifies);
		const command = commands.get("fast");
		const sessionStart = handlers.get("session_start");
		assert.ok(command);
		assert.ok(sessionStart);

		sessionStart({ reason: "startup" }, ctx);
		assert.equal(statuses.at(-1), footerStatusLabel(false, true));
		assert.equal(notifies.length, 0);

		await command.handler("", ctx);
		assert.equal(statuses.at(-1), footerStatusLabel(true, true));
		assert.deepEqual(notifies, []);

		await command.handler("off", ctx);
		assert.equal(statuses.at(-1), footerStatusLabel(false, true));
		assert.deepEqual(notifies, []);
	});
});

test("/fast on notifies only when the footer cannot show the state", async () => {
	await withLoadedExtension(async ({ commands, handlers }) => {
		const statuses: Array<string | undefined> = [];
		const notifies: string[] = [];
		const ctx = createCtx(statuses, notifies, CLAUDE);
		const command = commands.get("fast");
		const sessionStart = handlers.get("session_start");
		assert.ok(command);
		assert.ok(sessionStart);

		sessionStart({ reason: "startup" }, ctx);
		assert.equal(statuses.at(-1), undefined);

		await command.handler("on", ctx);
		assert.equal(statuses.at(-1), undefined);
		assert.match(notifies.join("\n"), /not supported/);
	});
});

test("/fast default refuses unsupported models and does not write settings", async () => {
	await withLoadedExtension(async ({ commands, handlers }) => {
		const statuses: Array<string | undefined> = [];
		const notifies: string[] = [];
		const ctx = createCtx(statuses, notifies, CLAUDE);
		const command = commands.get("fast");
		const sessionStart = handlers.get("session_start");
		assert.ok(command);
		assert.ok(sessionStart);

		sessionStart({ reason: "startup" }, ctx);
		await command.handler("default on", ctx);
		assert.match(notifies.join("\n"), /Cannot set Fast default/);
		assert.equal(loadDefaultEnabled("anthropic/claude-opus-4-6"), false);
	});
});

test("legacy global enabled does not turn Fast on at startup", async () => {
	await withLoadedExtension(async ({ handlers }) => {
		await writeFile(
			resolveSettingsPath(),
			`${JSON.stringify({ "fast-mode": { enabled: true } })}\n`,
			"utf8",
		);
		const statuses: Array<string | undefined> = [];
		const notifies: string[] = [];
		const ctx = createCtx(statuses, notifies);
		const sessionStart = handlers.get("session_start");
		assert.ok(sessionStart);

		sessionStart({ reason: "startup" }, ctx);
		assert.equal(statuses.at(-1), footerStatusLabel(false, true));
		assert.equal(notifies.length, 0);
	});
});

test("switching models follows that model's in-memory switch", async () => {
	await withLoadedExtension(async ({ commands, handlers }) => {
		const statuses: Array<string | undefined> = [];
		const notifies: string[] = [];
		const ctx = createCtx(statuses, notifies, GPT);
		const command = commands.get("fast");
		const sessionStart = handlers.get("session_start");
		const modelSelect = handlers.get("model_select");
		assert.ok(command);
		assert.ok(sessionStart);
		assert.ok(modelSelect);

		sessionStart({ reason: "startup" }, ctx);
		await command.handler("on", ctx);
		assert.equal(statuses.at(-1), footerStatusLabel(true, true));

		setCtxModel(ctx, GROK);
		modelSelect({}, ctx);
		assert.equal(statuses.at(-1), footerStatusLabel(false, true));

		setCtxModel(ctx, GPT);
		modelSelect({}, ctx);
		assert.equal(statuses.at(-1), footerStatusLabel(true, true));
		assert.equal(notifies.length, 0);
	});
});

test("first use of a model reads only that model's startup default", async () => {
	await withLoadedExtension(async ({ commands, handlers }) => {
		writeDefaultEnabled("openai/gpt-5.6", true);
		const statuses: Array<string | undefined> = [];
		const notifies: string[] = [];
		const ctx = createCtx(statuses, notifies, GPT);
		const command = commands.get("fast");
		const sessionStart = handlers.get("session_start");
		const modelSelect = handlers.get("model_select");
		assert.ok(command);
		assert.ok(sessionStart);
		assert.ok(modelSelect);

		sessionStart({ reason: "startup" }, ctx);
		assert.equal(statuses.at(-1), footerStatusLabel(true, true));

		setCtxModel(ctx, GROK);
		modelSelect({}, ctx);
		assert.equal(statuses.at(-1), footerStatusLabel(false, true));

		await command.handler("on", ctx);
		assert.equal(statuses.at(-1), footerStatusLabel(true, true));

		sessionStart({ reason: "new" }, ctx);
		assert.equal(statuses.at(-1), footerStatusLabel(true, true));

		sessionStart({ reason: "reload" }, ctx);
		assert.equal(statuses.at(-1), footerStatusLabel(false, true));
		assert.equal(loadDefaultEnabled("xai/grok-4.6"), false);
	});
});

test("/fast default on does not turn the current switch on until reload", async () => {
	await withLoadedExtension(async ({ commands, handlers }) => {
		const statuses: Array<string | undefined> = [];
		const notifies: string[] = [];
		const ctx = createCtx(statuses, notifies, GPT);
		const command = commands.get("fast");
		const sessionStart = handlers.get("session_start");
		assert.ok(command);
		assert.ok(sessionStart);

		sessionStart({ reason: "startup" }, ctx);
		assert.equal(statuses.at(-1), footerStatusLabel(false, true));

		await command.handler("default on", ctx);
		assert.equal(loadDefaultEnabled("openai/gpt-5.6"), true);
		assert.equal(statuses.at(-1), footerStatusLabel(false, true));

		sessionStart({ reason: "reload" }, ctx);
		assert.equal(statuses.at(-1), footerStatusLabel(true, true));
	});
});

test("turning Fast on for an unsupported model does not leak to the next model", async () => {
	await withLoadedExtension(async ({ commands, handlers }) => {
		const statuses: Array<string | undefined> = [];
		const notifies: string[] = [];
		const ctx = createCtx(statuses, notifies, CLAUDE);
		const command = commands.get("fast");
		const sessionStart = handlers.get("session_start");
		const modelSelect = handlers.get("model_select");
		assert.ok(command);
		assert.ok(sessionStart);
		assert.ok(modelSelect);

		sessionStart({ reason: "startup" }, ctx);
		await command.handler("on", ctx);
		assert.match(notifies.join("\n"), /not supported/);

		setCtxModel(ctx, GPT);
		modelSelect({}, ctx);
		assert.equal(statuses.at(-1), footerStatusLabel(false, true));
	});
});
