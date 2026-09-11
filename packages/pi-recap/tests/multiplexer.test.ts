import assert from "node:assert/strict";
import test from "node:test";
import {
	buildMultiplexerName,
	cleanMultiplexerName,
	detectMultiplexer,
	migrateMultiplexerConfig,
	MultiplexerManager,
	type CommandRunner,
	type MultiplexerConfig,
	type MultiplexerHooks,
	type MultiplexerNameContext,
} from "../extensions/multiplexer.ts";

const CONFIG: MultiplexerConfig = {
	enabled: true,
	template: "{session}",
	maxLength: 48,
	restoreOnShutdown: true,
};

const CONTEXT: MultiplexerNameContext = {
	sessionName: "auth refresh",
	cwd: "/work/project",
	sessionId: "session-1234567890",
};

type Call = { command: string; args: string[] };

function createHooks(): {
	hooks: MultiplexerHooks;
	titles: string[];
	warnings: string[];
} {
	const titles: string[] = [];
	const warnings: string[] = [];
	return {
		hooks: {
			setTitle: (name) => titles.push(name),
			warn: (message) => warnings.push(message),
		},
		titles,
		warnings,
	};
}

function paneJson(paneId: string, label: string | undefined): string {
	return JSON.stringify({
		id: "test",
		result: {
			type: "pane_info",
			pane: {
				pane_id: paneId,
				...(label === undefined ? {} : { label }),
			},
		},
	});
}

function createHerdrRunner(initialLabel: string | null = "shell") {
	let label: string | undefined = initialLabel ?? undefined;
	const calls: Call[] = [];
	const runner: CommandRunner = async (command, args) => {
		calls.push({ command, args: [...args] });
		assert.equal(command, "herdr");
		assert.equal(args[0], "pane");
		if (args[1] === "get") {
			return { stdout: paneJson(args[2]!, label) };
		}
		if (args[1] === "rename") {
			label = args[3] === "--clear" ? undefined : args[3]!;
			return { stdout: "{}" };
		}
		throw new Error(`Unexpected Herdr command: ${args.join(" ")}`);
	};
	return {
		runner,
		calls,
		get label() {
			return label;
		},
		set label(value: string | undefined) {
			label = value;
		},
	};
}

function createTmuxRunner(initialAutomaticRename = "on") {
	let currentName = "shell";
	let automaticRename = initialAutomaticRename;
	const calls: Call[] = [];
	const runner: CommandRunner = async (command, args) => {
		calls.push({ command, args: [...args] });
		assert.equal(command, "tmux");
		if (args[0] === "display-message" && args.at(-1) === "#{window_id}") {
			return { stdout: "@7\n" };
		}
		if (args[0] === "display-message" && args.at(-1) === "#{window_name}") {
			return { stdout: `${currentName}\n` };
		}
		if (args[0] === "show-window-options") {
			return { stdout: `${automaticRename}\n` };
		}
		if (args[0] === "set-window-option") {
			automaticRename = args.includes("-u") ? "" : args.at(-1)!;
			return { stdout: "" };
		}
		if (args[0] === "rename-window") {
			currentName = args.at(-1)!;
			return { stdout: "" };
		}
		throw new Error(`Unexpected tmux command: ${args.join(" ")}`);
	};
	return {
		runner,
		calls,
		get currentName() {
			return currentName;
		},
		set currentName(value: string) {
			currentName = value;
		},
		get automaticRename() {
			return automaticRename;
		},
	};
}

test("detects no multiplexer without environment markers", () => {
	assert.deepEqual(detectMultiplexer({}), { kind: "none" });
});

test("detects tmux when it is the nearest multiplexer", () => {
	assert.deepEqual(detectMultiplexer({ TMUX: "/tmp/tmux,1,0" }), { kind: "tmux" });
});

test("detects Herdr pane before inherited tmux", () => {
	assert.deepEqual(
		detectMultiplexer({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", TMUX: "/tmp/tmux,1,0" }),
		{ kind: "herdr", paneId: "w1:p2" },
	);
});

test("treats Herdr without a pane id as an invalid nearest layer", () => {
	assert.deepEqual(detectMultiplexer({ HERDR_ENV: "1", TMUX: "/tmp/tmux,1,0" }), {
		kind: "herdr-invalid",
	});
});

test("ignores stray Herdr pane ids without the Herdr marker", () => {
	assert.deepEqual(detectMultiplexer({ HERDR_PANE_ID: "w1:p2", TMUX: "tmux" }), { kind: "tmux" });
});

test("builds one shared name for either multiplexer", () => {
	assert.equal(
		buildMultiplexerName(
			{ ...CONFIG, template: "π {session} · {project} · {cwd} · {id}" },
			CONTEXT,
		),
		"π auth refresh · project · /work/project · sess…",
	);
});

test("uses the short session id when Pi has no session name", () => {
	assert.equal(
		buildMultiplexerName({ ...CONFIG, template: "{session}" }, { ...CONTEXT, sessionName: undefined }),
		"session-",
	);
});

test("cleans control characters, whitespace, and long labels", () => {
	assert.equal(cleanMultiplexerName("  auth\n\trefresh\u0000 now  ", 16), "authrefresh now");
	assert.equal(cleanMultiplexerName("1234567890", 6), "12345…");
});

test("migrates legacy tmux config to multiplexer config", () => {
	assert.deepEqual(
		migrateMultiplexerConfig({
			recap: { auto: false },
			tmux: { enabled: false, template: "old", maxLength: 60, restoreOnShutdown: false },
		}),
		{
			changed: true,
			value: {
				recap: { auto: false },
				multiplexer: { enabled: false, template: "old", maxLength: 60, restoreOnShutdown: false },
			},
		},
	);
});

test("new multiplexer fields win while legacy tmux fills missing fields", () => {
	assert.deepEqual(
		migrateMultiplexerConfig({
			tmux: { enabled: false, template: "old", maxLength: 60 },
			multiplexer: { template: "new", restoreOnShutdown: true },
		}).value,
		{
			multiplexer: {
				enabled: false,
				template: "new",
				maxLength: 60,
				restoreOnShutdown: true,
			},
		},
	);
});

test("removes malformed legacy tmux config without inventing values", () => {
	assert.deepEqual(migrateMultiplexerConfig({ tmux: false, recap: {} }), {
		changed: true,
		value: { recap: {} },
	});
});

test("Herdr sync renames the fixed pane and restores its original label", async () => {
	const herdr = createHerdrRunner("shell");
	const ui = createHooks();
	const manager = new MultiplexerManager({
		environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" },
		runner: herdr.runner,
	});

	await manager.sync(CONFIG, CONTEXT, ui.hooks);
	assert.equal(herdr.label, "auth refresh");
	assert.deepEqual(ui.titles, ["auth refresh"]);

	await manager.shutdown(CONFIG, "quit", ui.hooks);
	assert.equal(herdr.label, "shell");
	assert.equal(ui.warnings.length, 0);
	assert.ok(herdr.calls.every((call) => call.command === "herdr"));
});

test("Herdr restore clears a pane that originally had no manual label", async () => {
	const herdr = createHerdrRunner(null);
	const ui = createHooks();
	const manager = new MultiplexerManager({
		environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" },
		runner: herdr.runner,
	});

	await manager.sync(CONFIG, CONTEXT, ui.hooks);
	await manager.shutdown(CONFIG, "quit", ui.hooks);

	assert.equal(herdr.label, undefined);
	assert.ok(
		herdr.calls.some((call) => call.args.join(" ") === "pane rename w1:p2 --clear"),
		"shutdown should clear the label",
	);
});

test("nested Herdr never calls tmux", async () => {
	const herdr = createHerdrRunner();
	const ui = createHooks();
	const manager = new MultiplexerManager({
		environment: {
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w1:p2",
			TMUX: "/tmp/tmux,1,0",
		},
		runner: herdr.runner,
	});

	await manager.sync(CONFIG, CONTEXT, ui.hooks);
	assert.ok(herdr.calls.length > 0);
	assert.ok(herdr.calls.every((call) => call.command === "herdr"));
});

test("uses HERDR_BIN_PATH when Herdr provides a CLI path", async () => {
	const commands: string[] = [];
	let label = "shell";
	const runner: CommandRunner = async (command, args) => {
		commands.push(command);
		if (args[1] === "get") return { stdout: paneJson("w1:p2", label) };
		label = args[3]!;
		return { stdout: "{}" };
	};
	const manager = new MultiplexerManager({
		environment: {
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w1:p2",
			HERDR_BIN_PATH: "/opt/herdr/bin/herdr",
		},
		runner,
	});

	await manager.sync(CONFIG, CONTEXT, createHooks().hooks);
	assert.equal(label, "auth refresh");
	assert.ok(commands.every((command) => command === "/opt/herdr/bin/herdr"));
});

test("invalid Herdr identity warns once and never falls back to tmux", async () => {
	const calls: Call[] = [];
	const ui = createHooks();
	const manager = new MultiplexerManager({
		environment: { HERDR_ENV: "1", TMUX: "/tmp/tmux,1,0" },
		runner: async (command, args) => {
			calls.push({ command, args });
			return { stdout: "" };
		},
	});

	await manager.sync(CONFIG, CONTEXT, ui.hooks);
	await manager.sync(CONFIG, CONTEXT, ui.hooks);

	assert.deepEqual(calls, []);
	assert.equal(ui.warnings.length, 1);
	assert.match(ui.warnings[0]!, /HERDR_PANE_ID/);
});

test("Herdr capture failure retries safely, warns once, and never calls tmux", async () => {
	const calls: Call[] = [];
	const ui = createHooks();
	const manager = new MultiplexerManager({
		environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", TMUX: "tmux" },
		runner: async (command, args) => {
			calls.push({ command, args });
			throw new Error("server unavailable");
		},
	});

	await manager.sync(CONFIG, CONTEXT, ui.hooks);
	await manager.sync(CONFIG, CONTEXT, ui.hooks);

	assert.equal(calls.length, 2);
	assert.ok(calls.every((call) => call.command === "herdr"));
	assert.equal(ui.warnings.length, 1);
});

test("Herdr rejects invalid JSON and mismatched pane ids", async () => {
	for (const stdout of ["not-json", paneJson("w9:p9", "other")]) {
		const ui = createHooks();
		const manager = new MultiplexerManager({
			environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" },
			runner: async () => ({ stdout }),
		});
		await manager.sync(CONFIG, CONTEXT, ui.hooks);
		assert.equal(ui.titles.length, 0);
		assert.equal(ui.warnings.length, 1);
	}
});

test("same generated name is applied only once", async () => {
	const herdr = createHerdrRunner();
	const ui = createHooks();
	const manager = new MultiplexerManager({
		environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" },
		runner: herdr.runner,
	});

	await manager.sync(CONFIG, CONTEXT, ui.hooks);
	await manager.sync(CONFIG, CONTEXT, ui.hooks);

	assert.equal(
		herdr.calls.filter((call) => call.args[1] === "rename").length,
		1,
	);
	assert.deepEqual(ui.titles, ["auth refresh"]);
});

test("queued session-name changes are applied in order", async () => {
	let label = "shell";
	let releaseFirstRename: (() => void) | undefined;
	const firstRenameBlocked = new Promise<void>((resolve) => {
		releaseFirstRename = resolve;
	});
	const renamed: string[] = [];
	const runner: CommandRunner = async (_command, args) => {
		if (args[1] === "get") return { stdout: paneJson("w1:p2", label) };
		if (args[1] === "rename") {
			const next = args[3]!;
			renamed.push(next);
			if (renamed.length === 1) await firstRenameBlocked;
			label = next;
			return { stdout: "{}" };
		}
		throw new Error("unexpected command");
	};
	const manager = new MultiplexerManager({
		environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" },
		runner,
	});
	const ui = createHooks();

	const first = manager.sync(CONFIG, { ...CONTEXT, sessionName: "first" }, ui.hooks);
	await new Promise((resolve) => setImmediate(resolve));
	const second = manager.sync(CONFIG, { ...CONTEXT, sessionName: "second" }, ui.hooks);
	assert.deepEqual(renamed, ["first"]);
	releaseFirstRename?.();
	await Promise.all([first, second]);

	assert.deepEqual(renamed, ["first", "second"]);
	assert.equal(label, "second");
});

test("disabling sync immediately restores an owned Herdr label", async () => {
	const herdr = createHerdrRunner("shell");
	const manager = new MultiplexerManager({
		environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" },
		runner: herdr.runner,
	});
	const ui = createHooks();

	await manager.sync(CONFIG, CONTEXT, ui.hooks);
	await manager.sync({ ...CONFIG, enabled: false }, CONTEXT, ui.hooks);
	assert.equal(herdr.label, "shell");
});

test("reload restores even when ordinary shutdown restoration is disabled", async () => {
	const herdr = createHerdrRunner("shell");
	const config = { ...CONFIG, restoreOnShutdown: false };
	const ui = createHooks();
	const first = new MultiplexerManager({
		environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" },
		runner: herdr.runner,
	});

	await first.sync(config, CONTEXT, ui.hooks);
	await first.shutdown(config, "reload", ui.hooks);
	assert.equal(herdr.label, "shell");

	const reloaded = new MultiplexerManager({
		environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" },
		runner: herdr.runner,
	});
	await reloaded.sync(config, CONTEXT, ui.hooks);
	assert.equal(herdr.label, "auth refresh");
});

test("ordinary shutdown honors restoreOnShutdown false", async () => {
	const herdr = createHerdrRunner("shell");
	const config = { ...CONFIG, restoreOnShutdown: false };
	const manager = new MultiplexerManager({
		environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" },
		runner: herdr.runner,
	});
	const ui = createHooks();

	await manager.sync(config, CONTEXT, ui.hooks);
	await manager.shutdown(config, "quit", ui.hooks);
	assert.equal(herdr.label, "auth refresh");
});

test("manual Herdr rename is preserved on shutdown", async () => {
	const herdr = createHerdrRunner("shell");
	const manager = new MultiplexerManager({
		environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" },
		runner: herdr.runner,
	});
	const ui = createHooks();

	await manager.sync(CONFIG, CONTEXT, ui.hooks);
	herdr.label = "manual label";
	await manager.shutdown(CONFIG, "quit", ui.hooks);
	assert.equal(herdr.label, "manual label");
});

test("tmux sync preserves window behavior and restores automatic rename", async () => {
	const tmux = createTmuxRunner();
	const ui = createHooks();
	const manager = new MultiplexerManager({
		environment: { TMUX: "/tmp/tmux,1,0" },
		runner: tmux.runner,
	});

	await manager.sync(CONFIG, CONTEXT, ui.hooks);
	assert.equal(tmux.currentName, "auth refresh");
	assert.equal(tmux.automaticRename, "off");
	assert.deepEqual(ui.titles, ["auth refresh"]);

	await manager.shutdown(CONFIG, "quit", ui.hooks);
	assert.equal(tmux.currentName, "shell");
	assert.equal(tmux.automaticRename, "on");
});

test("tmux sync tolerates automatic-rename unset at the window level", async () => {
	const tmux = createTmuxRunner("");
	const ui = createHooks();
	const manager = new MultiplexerManager({
		environment: { TMUX: "/tmp/tmux,1,0" },
		runner: tmux.runner,
	});

	await manager.sync(CONFIG, CONTEXT, ui.hooks);
	assert.deepEqual(ui.warnings, []);
	assert.equal(tmux.currentName, "auth refresh");
	assert.equal(tmux.automaticRename, "off");

	await manager.shutdown(CONFIG, "quit", ui.hooks);
	assert.equal(tmux.currentName, "shell");
	assert.equal(tmux.automaticRename, "");
	assert.ok(
		tmux.calls.some((call) => call.args[0] === "set-window-option" && call.args.includes("-u")),
	);
});

test("manual tmux rename is preserved while automatic rename is restored", async () => {
	const tmux = createTmuxRunner();
	const ui = createHooks();
	const manager = new MultiplexerManager({
		environment: { TMUX: "/tmp/tmux,1,0" },
		runner: tmux.runner,
	});

	await manager.sync(CONFIG, CONTEXT, ui.hooks);
	tmux.currentName = "manual window";
	await manager.shutdown(CONFIG, "quit", ui.hooks);

	assert.equal(tmux.currentName, "manual window");
	assert.equal(tmux.automaticRename, "on");
});

test("tmux apply failure does not set terminal title and still releases automatic rename", async () => {
	const tmux = createTmuxRunner();
	const ui = createHooks();
	const runner: CommandRunner = async (command, args) => {
		if (args[0] === "rename-window") throw new Error("rename failed");
		return tmux.runner(command, args);
	};
	const manager = new MultiplexerManager({ environment: { TMUX: "tmux" }, runner });

	await manager.sync(CONFIG, CONTEXT, ui.hooks);
	assert.deepEqual(ui.titles, []);
	assert.equal(ui.warnings.length, 1);
	assert.equal(tmux.automaticRename, "off");

	await manager.sync({ ...CONFIG, enabled: false }, CONTEXT, ui.hooks);
	assert.equal(tmux.automaticRename, "on");
});

test("no multiplexer environment performs no command or title side effect", async () => {
	const calls: Call[] = [];
	const ui = createHooks();
	const manager = new MultiplexerManager({
		environment: {},
		runner: async (command, args) => {
			calls.push({ command, args });
			return { stdout: "" };
		},
	});

	await manager.sync(CONFIG, CONTEXT, ui.hooks);
	assert.deepEqual(calls, []);
	assert.deepEqual(ui.titles, []);
	assert.deepEqual(ui.warnings, []);
});
