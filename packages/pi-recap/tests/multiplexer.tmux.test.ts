import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
	MultiplexerManager,
	type CommandOutput,
	type CommandRunner,
	type MultiplexerConfig,
	type MultiplexerHooks,
} from "../extensions/multiplexer.ts";

const execFile = promisify(execFileCallback);

const CONFIG: MultiplexerConfig = {
	enabled: true,
	template: "{session}",
	maxLength: 48,
	restoreOnShutdown: true,
};

const CONTEXT = {
	sessionName: "auth refresh",
	cwd: "/work/project",
	sessionId: "session-1234567890",
};

const LOCAL_STATES = ["unset", "on", "off"] as const;
type LocalAutomaticRename = (typeof LOCAL_STATES)[number];

const SERVER_READY_MS = 5_000;
const COMMAND_TIMEOUT_MS = 2_000;
const TEST_TIMEOUT_MS = 20_000;

type TmuxProbe = {
	bin: string;
	version: string;
};

function cleanEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.TMUX;
	delete env.TMUX_TMPDIR;
	delete env.HERDR_ENV;
	delete env.HERDR_PANE_ID;
	return env;
}

function probeTmux(): TmuxProbe | undefined {
	const result = spawnSync("tmux", ["-V"], {
		encoding: "utf8",
		timeout: COMMAND_TIMEOUT_MS,
		env: cleanEnv(),
	});
	if (result.status !== 0 || result.error) return undefined;
	const version = `${result.stdout}${result.stderr}`.trim();
	return version ? { bin: "tmux", version } : undefined;
}

function createHooks(): { hooks: MultiplexerHooks; titles: string[]; warnings: string[] } {
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

async function runTmux(bin: string, socket: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandOutput> {
	const { stdout, stderr } = await execFile(bin, ["-S", socket, ...args], {
		encoding: "utf8",
		timeout: timeoutMs,
		env: cleanEnv(),
	});
	return { stdout: String(stdout), stderr: String(stderr) };
}

function flagIncludesQ(arg: string): boolean {
	return arg.startsWith("-") && !arg.startsWith("--") && arg.includes("q");
}

function createSocketRunner(bin: string, socket: string): CommandRunner {
	return async (command, args) => {
		assert.equal(command, "tmux");
		if (args[0] === "show-window-options") {
			assert.ok(
				!args.some(flagIncludesQ),
				`show-window-options does not support -q; received: ${args.join(" ")}`,
			);
		}
		return runTmux(bin, socket, args);
	};
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForServer(bin: string, socket: string): Promise<void> {
	const deadline = Date.now() + SERVER_READY_MS;
	let lastError = "tmux server did not become ready";
	while (Date.now() < deadline) {
		try {
			await runTmux(bin, socket, ["list-sessions"], 500);
			return;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			await delay(50);
		}
	}
	throw new Error(`tmux server was not ready within ${SERVER_READY_MS}ms: ${lastError}`);
}

async function startIsolatedServer(bin: string, socket: string, session: string): Promise<void> {
	await execFile(bin, ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "-n", "orig"], {
		encoding: "utf8",
		timeout: COMMAND_TIMEOUT_MS,
		env: cleanEnv(),
	});
}

async function stopIsolatedServer(bin: string, socket: string, serverPid: number | undefined): Promise<void> {
	try {
		await runTmux(bin, socket, ["kill-server"]);
	} catch {
		// Socket-targeted kill-server is enough when the isolated server is already gone.
	}
	if (serverPid !== undefined && pidAlive(serverPid)) {
		process.kill(serverPid, "SIGTERM");
		const deadline = Date.now() + 2_000;
		while (Date.now() < deadline && pidAlive(serverPid)) await delay(50);
		if (pidAlive(serverPid)) process.kill(serverPid, "SIGKILL");
	}
}

async function withIsolatedTmux(
	probe: TmuxProbe,
	fn: (ctx: { socket: string; windowId: string; runner: CommandRunner }) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-recap-tmux-"));
	const socket = path.join(dir, "s");
	const session = `recap-it-${process.pid}-${Date.now()}`;
	let serverPid: number | undefined;
	try {
		await startIsolatedServer(probe.bin, socket, session);
		await waitForServer(probe.bin, socket);
		const pidOutput = (await runTmux(probe.bin, socket, ["display-message", "-p", "#{pid}"])).stdout.trim();
		serverPid = Number.parseInt(pidOutput, 10);
		if (!Number.isInteger(serverPid)) serverPid = undefined;
		const windowId = (await runTmux(probe.bin, socket, ["display-message", "-p", "#{window_id}"])).stdout.trim();
		assert.ok(windowId, "isolated tmux window id query returned empty output");
		await fn({
			socket,
			windowId,
			runner: createSocketRunner(probe.bin, socket),
		});
	} finally {
		await stopIsolatedServer(probe.bin, socket, serverPid);
		await rm(dir, { recursive: true, force: true });
	}
}

async function setLocalAutomaticRename(
	bin: string,
	socket: string,
	windowId: string,
	state: LocalAutomaticRename,
): Promise<void> {
	if (state === "unset") {
		await runTmux(bin, socket, ["set-window-option", "-u", "-t", windowId, "automatic-rename"]);
		return;
	}
	await runTmux(bin, socket, ["set-window-option", "-t", windowId, "automatic-rename", state]);
}

async function readLocalAutomaticRename(bin: string, socket: string, windowId: string): Promise<string> {
	return (await runTmux(bin, socket, ["show-window-options", "-v", "-t", windowId, "automatic-rename"])).stdout.trim();
}

async function readWindowName(bin: string, socket: string, windowId: string): Promise<string> {
	return (await runTmux(bin, socket, ["display-message", "-p", "-t", windowId, "#{window_name}"])).stdout.trim();
}

function expectedLocalValue(state: LocalAutomaticRename): string {
	return state === "unset" ? "" : state;
}

const tmux = probeTmux();
const skipReason = tmux
	? false
	: "tmux is not available on PATH; real MultiplexerManager command-contract test skipped";

test(
	`real tmux MultiplexerManager syncs and restores unset/on/off automatic-rename${tmux ? ` (${tmux.version})` : ""}`,
	{ skip: skipReason, timeout: TEST_TIMEOUT_MS },
	async (t) => {
		assert.ok(tmux, "tmux probe succeeded");
		await withIsolatedTmux(tmux, async ({ socket, windowId, runner }) => {
			for (const original of LOCAL_STATES) {
				await t.test(`restores original local automatic-rename=${original}`, async () => {
					await runTmux(tmux.bin, socket, ["rename-window", "-t", windowId, "orig"]);
					await setLocalAutomaticRename(tmux.bin, socket, windowId, original);
					assert.equal(await readLocalAutomaticRename(tmux.bin, socket, windowId), expectedLocalValue(original));

					const manager = new MultiplexerManager({
						environment: { TMUX: `${socket},1,0` },
						runner,
					});
					const ui = createHooks();

					await manager.sync(CONFIG, CONTEXT, ui.hooks);
					assert.deepEqual(ui.warnings, [], `sync should not warn for original=${original}`);
					assert.deepEqual(ui.titles, ["auth refresh"]);
					assert.equal(await readWindowName(tmux.bin, socket, windowId), "auth refresh");
					assert.equal(await readLocalAutomaticRename(tmux.bin, socket, windowId), "off");

					await manager.shutdown(CONFIG, "quit", ui.hooks);
					assert.deepEqual(ui.warnings, [], `shutdown should not warn for original=${original}`);
					assert.equal(await readLocalAutomaticRename(tmux.bin, socket, windowId), expectedLocalValue(original));
					if (original === "off") {
						assert.equal(await readWindowName(tmux.bin, socket, windowId), "orig");
					}
				});
			}
		});
	},
);
