import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_CONFIG,
	type CompanionConfig,
	type ProcessShell,
} from "../src/config.ts";
import {
	ProcessManager,
	classifyForegroundProcess,
	type ProcessClient,
} from "../src/process/manager.ts";
import { formatProcessList } from "../src/process/tool.ts";
import type {
	PreparedPaneCommand,
	ProcessCommandPreparer,
} from "../src/process/transport.ts";
import {
	PROCESS_OWNER,
	PROCESS_STATE_CUSTOM_TYPE,
	PROCESS_STATE_VERSION,
	ProcessRegistry,
	deriveProcessLabel,
	mayCloseOwnedProcess,
	processEntriesToCloseOnShutdown,
	processEntriesToCloseOnStart,
	processServerScope,
	restoreProcessRegistry,
	type ProcessEntry,
	type ProcessRegistrySnapshot,
} from "../src/process/registry.ts";

function config(): CompanionConfig {
	return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as CompanionConfig;
}

function owned(overrides: Partial<ProcessEntry> = {}): ProcessEntry {
	const paneId = overrides.paneId ?? "w1:p2";
	const hasTerminalOverride = Object.prototype.hasOwnProperty.call(overrides, "terminalId");
	const terminalId = hasTerminalOverride
		? overrides.terminalId
		: `term-${paneId.replaceAll(":", "-")}`;
	const serverScope = Object.prototype.hasOwnProperty.call(overrides, "serverScope")
		? overrides.serverScope
		: terminalId ? processServerScope("/tmp/herdr") : undefined;
	return {
		owner: PROCESS_OWNER,
		paneId,
		...(terminalId ? { terminalId } : {}),
		...(serverScope ? { serverScope } : {}),
		workspaceId: paneId.split(":")[0],
		tabId: `${paneId.split(":")[0]}:t1`,
		label: "dev",
		command: "pnpm dev",
		cwd: "/work",
		lifetime: "session",
		createdAt: "2026-08-09T12:00:00.000Z",
		ownerSessionId: "session-1",
		ownerPaneId: "w1:p1",
		...overrides,
	};
}

type FakeForeground = "running" | "shell" | "unknown";

class FakeProcessClient implements ProcessClient {
	panes = new Set(["w1:p1"]);
	terminalIds = new Map<string, string>([["w1:p1", "term-caller"]]);
	paneMetadata = new Map<string, { agent?: string; agentStatus?: string; agentSession?: { agent: string } }>();
	foreground = new Map<string, FakeForeground>();
	calls: Array<{ name: string; args: unknown[] }> = [];
	output = "logs\n";
	failRun = false;
	failList = false;
	failClose = false;
	omitSplitTerminalId = false;
	waitOutputHandler?: (signal?: AbortSignal) => Promise<string>;

	async splitPane(options: unknown) {
		this.calls.push({ name: "split", args: [options] });
		this.panes.add("w1:p2");
		this.terminalIds.set("w1:p2", "term-managed");
		return {
			paneId: "w1:p2",
			...(this.omitSplitTerminalId ? {} : { terminalId: "term-managed" }),
			workspaceId: "w1",
			tabId: "w1:t1",
		};
	}
	async listPanes() {
		this.calls.push({ name: "list", args: [] });
		if (this.failList) throw new Error("pane list unavailable");
		return [...this.panes].map((paneId) => ({
			paneId,
			terminalId: this.terminalIds.get(paneId) ?? `term-${paneId.replaceAll(":", "-")}`,
			workspaceId: paneId.split(":")[0],
			tabId: `${paneId.split(":")[0]}:t1`,
			...this.paneMetadata.get(paneId),
		}));
	}
	async getPaneProcessInfo(paneId: string) {
		this.calls.push({ name: "process-info", args: [paneId] });
		const state = this.foreground.get(paneId) ?? "unknown";
		if (state === "unknown") throw new Error("process-info unavailable");
		return state === "running"
			? {
				paneId,
				shellPid: 100,
				foregroundProcessGroupId: 200,
				foregroundProcesses: [{ pid: 200, name: "node" }],
			}
			: {
				paneId,
				shellPid: 100,
				foregroundProcessGroupId: 100,
				foregroundProcesses: [{ pid: 100, name: "fish" }],
			};
	}
	async renamePane(...args: [string, string]) {
		this.calls.push({ name: "rename", args });
	}
	async runPane(...args: [string, string]) {
		this.calls.push({ name: "run", args });
		if (this.failRun) throw new Error("run failed");
		this.foreground.set(args[0], "running");
	}
	async waitOutput(paneId: string, options: unknown, signal?: AbortSignal) {
		this.calls.push({ name: "wait", args: [paneId, options] });
		return this.waitOutputHandler ? this.waitOutputHandler(signal) : "ready";
	}
	async readPane(...args: [string, number]) {
		this.calls.push({ name: "read", args });
		return this.output;
	}
	async focusPane(paneId: string) {
		this.calls.push({ name: "focus", args: [paneId] });
	}
	async closePane(paneId: string) {
		this.calls.push({ name: "close", args: [paneId] });
		if (this.failClose) throw new Error("pane close unavailable");
		this.panes.delete(paneId);
		this.terminalIds.delete(paneId);
		this.paneMetadata.delete(paneId);
		this.foreground.delete(paneId);
	}
}

class FakeCommandTransport implements ProcessCommandPreparer {
	calls: Array<{ command: string; shell: ProcessShell }> = [];
	cleanups = 0;

	async prepare(command: string, shell: ProcessShell): Promise<PreparedPaneCommand> {
		this.calls.push({ command, shell });
		let cleaned = false;
		return {
			paneCommand: shell === "bash" ? "/bin/bash '/private/process.sh'" : command,
			cleanup: async () => {
				if (cleaned) return;
				cleaned = true;
				this.cleanups += 1;
			},
		};
	}
}

function manager(
	client = new FakeProcessClient(),
	initial?: ProcessRegistrySnapshot,
	clock: { now: Date } = { now: new Date("2026-08-09T12:00:00.000Z") },
	overrides: { persist?(snapshot: ProcessRegistrySnapshot): void } = {},
) {
	const snapshots: ProcessRegistrySnapshot[] = [];
	const commandTransport = new FakeCommandTransport();
	const instance = new ProcessManager({
		client,
		runtime: { inside: true, paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", socketPath: "/tmp/herdr" },
		getConfig: config,
		persist: (snapshot) => {
			snapshots.push(snapshot);
			overrides.persist?.(snapshot);
		},
		commandTransport,
		now: () => clock.now,
		startGraceMs: 2_000,
	});
	if (initial) instance.registry.replace(initial);
	return { instance, client, snapshots, clock, commandTransport };
}

describe("process registry and ownership", () => {
	it("rehydrates the latest valid registry from custom state or tool details", () => {
		const first = { version: PROCESS_STATE_VERSION, entries: [owned()] } satisfies ProcessRegistrySnapshot;
		const second = { version: PROCESS_STATE_VERSION, entries: [owned({ paneId: "w1:p3", label: "preview" })] } satisfies ProcessRegistrySnapshot;
		const entries = [
			{ type: "custom", id: "a", parentId: null, timestamp: "", customType: PROCESS_STATE_CUSTOM_TYPE, data: first },
			{ type: "message", id: "b", parentId: "a", timestamp: "", message: {
				role: "toolResult", toolCallId: "tc", toolName: "herdr_process", content: [], isError: false, timestamp: 0,
				details: { registry: second },
			} },
		] as SessionEntry[];
		expect(restoreProcessRegistry(entries)).toEqual({ ...second, version: PROCESS_STATE_VERSION });
	});

	it("rejects duplicate labels and never considers caller ownership closable", () => {
		const registry = new ProcessRegistry({ version: 1, entries: [owned()] });
		expect(() => registry.add(owned({ paneId: "w1:p3" }))).toThrow(/label already exists/);
		expect(mayCloseOwnedProcess(owned(), "w1:p2")).toBe(false);
		expect(mayCloseOwnedProcess(owned({ paneId: "w1:p1" }), "w1:p1")).toBe(false);
	});

	it("derives short workflow labels without inventing pane ownership", () => {
		expect(deriveProcessLabel("pnpm run dev --host")).toBe("dev");
		expect(deriveProcessLabel("npm exec vite preview")).toBe("preview");
		expect(deriveProcessLabel("./scripts/custom-server.sh")).toBe("custom-server-sh");
	});

	it("classifies a foreground command separately from a returned shell", () => {
		expect(classifyForegroundProcess({
			paneId: "w1:p2", shellPid: 10, foregroundProcessGroupId: 20,
			foregroundProcesses: [{ pid: 20 }],
		})).toBe("command");
		expect(classifyForegroundProcess({
			paneId: "w1:p2", shellPid: 10, foregroundProcessGroupId: 10,
			foregroundProcesses: [{ pid: 10 }],
		})).toBe("shell");
		expect(classifyForegroundProcess({ paneId: "w1:p2", foregroundProcesses: [] })).toBe("unknown");
	});
});

describe("process manager behavior", () => {
	it("starts down/no-focus at ratio 0.35, waits for readiness, then durably owns the pane", async () => {
		const { instance, client, snapshots } = manager();
		const entry = await instance.start({ command: "pnpm dev", readyMatch: "Local:" }, { cwd: "/work", sessionId: "session-1" });
		expect(entry).toMatchObject({
			paneId: "w1:p2",
			terminalId: "term-managed",
			serverScope: processServerScope("/tmp/herdr"),
			workspaceId: "w1",
			tabId: "w1:t1",
			label: "dev",
			lifetime: "session",
			shell: "bash",
			owner: PROCESS_OWNER,
		});
		expect(client.calls[1]).toMatchObject({
			name: "split",
			args: [{ target: "current", direction: "down", ratio: 0.35, cwd: "/work", focus: false }],
		});
		expect(client.calls[3]?.name).toBe("run");
		expect(client.calls[3]?.args.slice(0, 2)).toEqual(["w1:p2", "/bin/bash '/private/process.sh'"]);
		expect(client.calls.map((call) => call.name)).toEqual(["list", "split", "rename", "run", "wait"]);
		expect(snapshots.at(-1)?.entries).toEqual([entry]);
	});

	it("lets shutdown abort readiness and close provisional ownership immediately", async () => {
		const { instance, client, snapshots } = manager();
		let announceWait!: () => void;
		const waiting = new Promise<void>((resolve) => { announceWait = resolve; });
		client.waitOutputHandler = async (signal) => {
			announceWait();
			return new Promise<string>((_resolve, reject) => {
				const abort = () => reject(signal?.reason ?? new Error("aborted"));
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
			});
		};
		const start = instance.start(
			{ command: "pnpm dev", readyMatch: "Local:", readyTimeoutMs: 600_000, lifetime: "persistent" },
			{ cwd: "/work", sessionId: "session-1" },
		);
		await waiting;
		expect(instance.registry.entries()).toHaveLength(1);
		await expect(instance.shutdown("quit")).resolves.toBeUndefined();
		await expect(start).rejects.toThrow(/session quit|aborted|cancelled/i);
		expect(client.calls.filter((call) => call.name === "close").map((call) => call.args[0])).toEqual(["w1:p2"]);
		expect(instance.registry.entries()).toEqual([]);
		expect(snapshots[0]?.entries).toHaveLength(1);
		expect(snapshots.at(-1)?.entries).toEqual([]);
	});

	it("does not let an aborted readiness fallback close a stale public Pane address", async () => {
		const { instance, client } = manager();
		let announceWait!: () => void;
		const waiting = new Promise<void>((resolve) => { announceWait = resolve; });
		client.waitOutputHandler = async (signal) => {
			announceWait();
			return new Promise<string>((_resolve, reject) => {
				const abort = () => reject(signal?.reason ?? new Error("aborted"));
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
			});
		};
		const start = instance.start(
			{ command: "pnpm dev", readyMatch: "Local:", readyTimeoutMs: 600_000 },
			{ cwd: "/work", sessionId: "session-1" },
		);
		await waiting;

		client.terminalIds.set("w1:p2", "term-unrelated");
		client.panes.add("w2:p7");
		client.terminalIds.set("w2:p7", "term-managed");
		client.failList = true;

		await expect(instance.shutdown("quit")).rejects.toThrow(/pane list unavailable/);
		await expect(start).rejects.toThrow(/cleanup was incomplete.*live terminal verification failed/);
		expect(client.calls.some((call) => call.name === "close")).toBe(false);
		expect(client.panes.has("w1:p2")).toBe(true);
		expect(client.panes.has("w2:p7")).toBe(true);
		expect(instance.registry.entries()).toEqual([
			expect.objectContaining({ paneId: "w1:p2", terminalId: "term-managed" }),
		]);
	});

	it("keeps a readiness-waiting pane observable and stoppable", async () => {
		const { instance, client } = manager();
		let announceWait!: () => void;
		const waiting = new Promise<void>((resolve) => { announceWait = resolve; });
		client.waitOutputHandler = async (signal) => {
			announceWait();
			return new Promise<string>((_resolve, reject) => {
				const abort = () => reject(signal?.reason ?? new Error("aborted"));
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
			});
		};
		const start = instance.start(
			{ command: "pnpm dev", readyMatch: "Local:" },
			{ cwd: "/work", sessionId: "session-1" },
		);
		await waiting;
		const listed = await instance.list();
		expect(listed.states["w1:p2"]).toBe("starting");
		await expect(instance.stop("dev")).resolves.toMatchObject({ paneId: "w1:p2" });
		await expect(start).rejects.toThrow(/stopped|cancelled/i);
		expect(instance.registry.entries()).toEqual([]);
	});

	it("keeps Bash source out of pane shell echo so its literal readiness marker is allowed", async () => {
		const { instance, client, commandTransport } = manager();
		await expect(instance.start(
			{ command: "node server.js --ready READY", readyMatch: "READY" },
			{ cwd: "/work", sessionId: "session-1" },
		)).resolves.toMatchObject({ shell: "bash" });
		expect(commandTransport.calls).toEqual([{ command: "node server.js --ready READY", shell: "bash" }]);
		expect(client.calls.find((call) => call.name === "run")?.args[1]).not.toContain("READY");
	});

	it("rejects a literal readiness marker that the fixed Bash wrapper could echo", async () => {
		const { instance, client, commandTransport } = manager();
		await expect(instance.start(
			{ command: "pnpm dev", readyMatch: "bash" },
			{ cwd: "/work", sessionId: "session-1" },
		)).rejects.toThrow(/pane launch command.*shell echo/);
		expect(client.calls.map((call) => call.name)).toEqual(["list"]);
		expect(commandTransport.cleanups).toBe(1);
	});

	it("rejects a literal readiness marker that raw pane shell echo could satisfy", async () => {
		const { instance, client } = manager();
		await expect(instance.start(
			{ command: "node server.js --ready READY", readyMatch: "READY", shell: "pane" },
			{ cwd: "/work", sessionId: "session-1" },
		)).rejects.toThrow(/pane shell echo.*anchored readyRegex/);
		expect(client.calls).toEqual([]);
	});

	it("supports an explicit raw pane-shell escape hatch", async () => {
		const { instance, client, commandTransport } = manager();
		await expect(instance.start(
			{ command: "set -gx MODE fish", shell: "pane" },
			{ cwd: "/work", sessionId: "session-1" },
		)).resolves.toMatchObject({ shell: "pane" });
		expect(commandTransport.calls).toEqual([{ command: "set -gx MODE fish", shell: "pane" }]);
		expect(client.calls.find((call) => call.name === "run")?.args.slice(0, 2)).toEqual(["w1:p2", "set -gx MODE fish"]);
	});

	it("closes an exact launched pane when provisional persistence fails", async () => {
		const client = new FakeProcessClient();
		const clock = { now: new Date("2026-08-09T12:00:00.000Z") };
		const { instance, commandTransport } = manager(client, undefined, clock, {
			persist: () => { throw new Error("append entry failed"); },
		});
		await expect(instance.start(
			{ command: "pnpm dev" },
			{ cwd: "/work", sessionId: "session-1" },
		)).rejects.toThrow(/append entry failed/);
		expect(client.calls.filter((call) => call.name === "close").map((call) => call.args[0])).toEqual(["w1:p2"]);
		expect(instance.registry.entries()).toEqual([]);
		expect(commandTransport.cleanups).toBe(1);
	});

	it("retains ownership and reports an actionable error when readiness cleanup cannot close", async () => {
		const client = new FakeProcessClient();
		client.failClose = true;
		client.waitOutputHandler = async () => { throw new Error("readiness timed out"); };
		const { instance, commandTransport } = manager(client);
		await expect(instance.start(
			{ command: "pnpm dev", readyMatch: "Local:" },
			{ cwd: "/work", sessionId: "session-1" },
		)).rejects.toThrow(/cleanup was incomplete.*herdr_process list\/stop/);
		expect(instance.registry.find("dev")).toMatchObject({ paneId: "w1:p2", shell: "bash" });
		expect(commandTransport.cleanups).toBe(1);

		client.failClose = false;
		await expect(instance.stop("dev")).resolves.toMatchObject({ paneId: "w1:p2" });
	});

	it("closes a created pane when Herdr omits terminal_id", async () => {
		const client = new FakeProcessClient();
		client.omitSplitTerminalId = true;
		const { instance } = manager(client);

		await expect(instance.start(
			{ command: "pnpm dev" },
			{ cwd: "/work", sessionId: "session-1" },
		)).rejects.toThrow(/did not return terminal_id/);
		expect(client.calls.at(-1)).toEqual({ name: "close", args: ["w1:p2"] });
		expect(instance.registry.entries()).toEqual([]);
	});

	it("closes a created orphan and records no ownership when launch fails", async () => {
		const client = new FakeProcessClient();
		client.failRun = true;
		const { instance, snapshots, commandTransport } = manager(client);
		await expect(instance.start({ command: "pnpm dev" }, { cwd: "/work", sessionId: "s" })).rejects.toThrow("run failed");
		expect(client.calls.at(-1)).toEqual({ name: "close", args: ["w1:p2"] });
		expect(commandTransport.cleanups).toBe(1);
		expect(instance.registry.entries()).toEqual([]);
		expect(snapshots).toEqual([]);
	});

	it("stops only a registered owned pane and refuses arbitrary/caller targets", async () => {
		const { instance, client } = manager();
		await instance.start({ command: "pnpm dev" }, { cwd: "/work", sessionId: "s" });
		await expect(instance.stop("w1:p9")).rejects.toThrow(/No owned process/);
		expect(client.calls.some((call) => call.name === "close" && call.args[0] === "w1:p9")).toBe(false);
		await expect(instance.stop("dev")).resolves.toMatchObject({ paneId: "w1:p2" });

		client.panes.add("w1:p1");
		instance.registry.replace({
			version: 1,
			entries: [owned({ paneId: "w1:p1", terminalId: "term-caller", ownerPaneId: "w1:p9" })],
		});
		await expect(instance.stop("w1:p1")).rejects.toThrow(/Refusing to close/);
		expect(client.panes.has("w1:p1")).toBe(true);
	});

	it("reconciles manually closed panes and persists stale removal", async () => {
		const client = new FakeProcessClient();
		const { instance, snapshots } = manager(client, { version: 1, entries: [owned()] });
		const result = await instance.list();
		expect(result.stale.map((entry) => entry.paneId)).toEqual(["w1:p2"]);
		expect(result.entries).toEqual([]);
		expect(snapshots.at(-1)?.entries).toEqual([]);
	});

	it("forgets a legacy pane-only entry without adopting or closing a reused public pane ID", async () => {
		const client = new FakeProcessClient();
		client.panes.add("w1:p2");
		client.terminalIds.set("w1:p2", "term-unrelated");
		const legacy = owned({ terminalId: undefined, serverScope: undefined });
		const { instance, snapshots } = manager(client, { version: 1, entries: [legacy] });

		const listed = await instance.list();

		expect(listed.entries).toEqual([]);
		expect(listed.stale).toEqual([legacy]);
		expect(snapshots.at(-1)).toMatchObject({ version: PROCESS_STATE_VERSION, entries: [] });
		expect(client.calls.some((call) => call.name === "close")).toBe(false);
	});

	it("tracks a moved pane by terminal_id for logs, focus, agent metadata, and stop", async () => {
		const client = new FakeProcessClient();
		client.panes.add("w1:p2");
		client.terminalIds.set("w1:p2", "term-managed");
		client.foreground.set("w1:p2", "running");
		const initial = owned({
			terminalId: "term-managed",
			serverScope: processServerScope("/tmp/herdr"),
			workspaceId: "w1",
			tabId: "w1:t1",
		});
		const { instance, snapshots } = manager(client, { version: PROCESS_STATE_VERSION, entries: [initial] });

		client.panes.delete("w1:p2");
		client.terminalIds.delete("w1:p2");
		client.foreground.delete("w1:p2");
		client.panes.add("w2:p7");
		client.terminalIds.set("w2:p7", "term-managed");
		client.foreground.set("w2:p7", "running");
		client.paneMetadata.set("w2:p7", {
			agent: "pi",
			agentStatus: "idle",
			agentSession: { agent: "pi" },
		});

		await expect(instance.logs("w1:p2")).resolves.toMatchObject({
			entry: { paneId: "w2:p7", terminalId: "term-managed" },
		});
		expect(client.calls.some((call) => call.name === "read" && call.args[0] === "w2:p7")).toBe(true);
		const listed = await instance.list();
		expect(listed.stale).toEqual([]);
		expect(listed.states).toMatchObject({ "w2:p7": "running" });
		expect(listed.panes["w2:p7"]).toMatchObject({
			workspaceId: "w2",
			tabId: "w2:t1",
			agent: "pi",
			agentStatus: "idle",
			hasAgentSession: true,
		});
		expect(snapshots.at(-1)?.entries[0]).toMatchObject({
			paneId: "w2:p7",
			workspaceId: "w2",
			tabId: "w2:t1",
		});
		await expect(instance.focus("dev")).resolves.toMatchObject({ paneId: "w2:p7" });
		expect(client.calls.some((call) => call.name === "focus" && call.args[0] === "w2:p7")).toBe(true);
		await expect(instance.stop("dev")).resolves.toMatchObject({ paneId: "w2:p7" });
		expect(client.calls.some((call) => call.name === "close" && call.args[0] === "w2:p7")).toBe(true);
	});

	it("removes stale address owners before relocating a live terminal into that pane ID", async () => {
		const client = new FakeProcessClient();
		client.panes.add("w1:p3");
		client.terminalIds.set("w1:p3", "term-dev");
		client.foreground.set("w1:p3", "running");
		const stableScope = processServerScope("/tmp/herdr");
		const dev = owned({ terminalId: "term-dev", serverScope: stableScope });
		const stalePreview = owned({
			paneId: "w1:p3",
			terminalId: "term-preview",
			serverScope: stableScope,
			label: "preview",
		});
		const { instance } = manager(client, {
			version: PROCESS_STATE_VERSION,
			entries: [dev, stalePreview],
		});

		const result = await instance.list();

		expect(result.stale).toEqual([stalePreview]);
		expect(result.entries).toEqual([
			expect.objectContaining({ label: "dev", paneId: "w1:p3", terminalId: "term-dev" }),
		]);
		expect(result.states).toMatchObject({ "w1:p3": "running" });
	});

	it("does not adopt a terminal identity from another Herdr server scope", async () => {
		const client = new FakeProcessClient();
		client.panes.add("w1:p2");
		client.terminalIds.set("w1:p2", "term-managed");
		const foreign = owned({
			terminalId: "term-managed",
			serverScope: processServerScope("/tmp/other-herdr"),
		});
		const { instance } = manager(client, { version: PROCESS_STATE_VERSION, entries: [foreign] });

		const listed = await instance.list();

		expect(listed.entries).toEqual([]);
		expect(listed.stale).toEqual([foreign]);
		expect(client.calls.some((call) => call.name === "close")).toBe(false);
	});

	it("keeps returned shells owned as exited for list, logs, labels, stop, and shutdown", async () => {
		const client = new FakeProcessClient();
		for (const paneId of ["w1:p2", "w1:p3"]) {
			client.panes.add(paneId);
			client.foreground.set(paneId, "shell");
		}
		client.output = "process crashed\nstack trace\n";
		const clock = { now: new Date("2026-08-09T12:00:10.000Z") };
		const initial = {
			version: 1,
			entries: [owned(), owned({ paneId: "w1:p3", label: "preview" })],
		} satisfies ProcessRegistrySnapshot;
		const { instance } = manager(client, initial, clock);

		const listed = await instance.list();
		expect(listed.entries.map((entry) => entry.paneId)).toEqual(["w1:p2", "w1:p3"]);
		expect(listed.stale).toEqual([]);
		expect(listed.states).toEqual({ "w1:p2": "exited", "w1:p3": "exited" });
		expect(formatProcessList(listed)).toContain("dev\tw1:p2\texited\tsession");
		expect(instance.registry.entries()).toEqual([
			expect.objectContaining({ paneId: "w1:p2", terminalId: "term-w1-p2" }),
			expect.objectContaining({ paneId: "w1:p3", terminalId: "term-w1-p3" }),
		]);

		await expect(instance.start(
			{ command: "pnpm dev" },
			{ cwd: "/work", sessionId: "session-1" },
		)).rejects.toThrow(/label already exists/);
		expect(client.calls.some((call) => call.name === "split")).toBe(false);

		await expect(instance.logs("dev")).resolves.toMatchObject({
			entry: { paneId: "w1:p2" },
			text: expect.stringContaining("process crashed"),
		});
		await expect(instance.stop("dev")).resolves.toMatchObject({ paneId: "w1:p2" });
		expect(client.panes.has("w1:p2")).toBe(false);
		expect(instance.registry.find("w1:p3")).toBeDefined();

		await instance.shutdown("quit");
		expect(client.panes.has("w1:p3")).toBe(false);
		expect(instance.registry.entries()).toEqual([]);
	});

	it("keeps a shell-looking pane during start grace and preserves unknown process-info", async () => {
		const client = new FakeProcessClient();
		client.panes.add("w1:p2");
		client.foreground.set("w1:p2", "shell");
		const clock = { now: new Date("2026-08-09T12:00:01.000Z") };
		const { instance } = manager(client, { version: 1, entries: [owned()] }, clock);
		expect(await instance.list()).toMatchObject({ states: { "w1:p2": "starting" } });
		client.foreground.set("w1:p2", "unknown");
		clock.now = new Date("2026-08-09T12:00:10.000Z");
		expect(await instance.list()).toMatchObject({ states: { "w1:p2": "unknown" } });
		expect(instance.registry.find("w1:p2")).toBeDefined();
	});

	it("tail-truncates logs to Pi's 50KB/2000-line contract", async () => {
		const client = new FakeProcessClient();
		client.panes.add("w1:p2");
		client.output = Array.from({ length: 3000 }, (_, index) => `line-${index}-${"x".repeat(30)}`).join("\n");
		const { instance } = manager(client, { version: 1, entries: [owned()] });
		const logs = await instance.logs("dev", 2000);
		expect(logs.truncated).toBe(true);
		expect(logs.text).toContain("Output truncated to the last");
		expect(logs.text).toContain("full output remains in Herdr pane w1:p2");
		expect(Buffer.byteLength(logs.text, "utf8")).toBeLessThan(53 * 1024);
	});

	it("preserves live ownership across reload and closes session-owned but not persistent panes otherwise", async () => {
		const client = new FakeProcessClient();
		client.panes.add("w1:p2");
		client.panes.add("w1:p3");
		const snapshot: ProcessRegistrySnapshot = {
			version: 1,
			entries: [owned(), owned({ paneId: "w1:p3", label: "preview", lifetime: "persistent" })],
		};
		const reloaded = manager(client);
		await reloaded.instance.rehydrate(snapshot, "reload");
		expect(client.calls.filter((call) => call.name === "close")).toEqual([]);
		await reloaded.instance.shutdown("quit");
		expect(client.calls.filter((call) => call.name === "close").map((call) => call.args[0])).toEqual(["w1:p2"]);
		expect(reloaded.instance.registry.entries().map((entry) => entry.paneId)).toEqual(["w1:p3"]);
	});

	it("never closes a pane-only legacy snapshot during replacement-session cleanup", async () => {
		const client = new FakeProcessClient();
		client.panes.add("w1:p2");
		client.terminalIds.set("w1:p2", "term-unrelated");
		const legacy = owned({ terminalId: undefined, serverScope: undefined });
		const resumed = manager(client);

		await expect(resumed.instance.rehydrate({ version: 1, entries: [legacy] }, "resume"))
			.resolves.toMatchObject({ entries: [] });
		expect(client.calls.some((call) => call.name === "close")).toBe(false);
	});

	it("closes a moved session pane only at its freshly verified terminal address", async () => {
		const client = new FakeProcessClient();
		client.panes.add("w2:p7");
		client.terminalIds.set("w2:p7", "term-managed");
		const snapshot = {
			version: PROCESS_STATE_VERSION,
			entries: [owned({ terminalId: "term-managed", serverScope: processServerScope("/tmp/herdr") })],
		} satisfies ProcessRegistrySnapshot;
		const resumed = manager(client);

		await expect(resumed.instance.rehydrate(snapshot, "resume"))
			.resolves.toMatchObject({ entries: [] });
		expect(client.calls.filter((call) => call.name === "close").map((call) => call.args[0]))
			.toEqual(["w2:p7"]);
	});

	it("never closes an unrelated pane occupying a stale persisted address", async () => {
		const client = new FakeProcessClient();
		client.panes.add("w1:p2");
		client.terminalIds.set("w1:p2", "term-unrelated");
		const snapshot = {
			version: PROCESS_STATE_VERSION,
			entries: [owned({ terminalId: "term-managed", serverScope: processServerScope("/tmp/herdr") })],
		} satisfies ProcessRegistrySnapshot;
		const resumed = manager(client);

		await expect(resumed.instance.rehydrate(snapshot, "resume"))
			.resolves.toMatchObject({ entries: [] });
		expect(client.calls.some((call) => call.name === "close")).toBe(false);
		expect(client.panes.has("w1:p2")).toBe(true);
	});

	it("leaves replacement cleanup pending when live terminal verification fails", async () => {
		const client = new FakeProcessClient();
		client.panes.add("w1:p2");
		client.failList = true;
		const snapshot = { version: PROCESS_STATE_VERSION, entries: [owned()] } satisfies ProcessRegistrySnapshot;
		const resumed = manager(client);

		await expect(resumed.instance.rehydrate(snapshot, "resume")).rejects.toThrow(/pane list unavailable/);
		expect(client.calls[0]).toEqual({ name: "list", args: [] });
		expect(client.calls.some((call) => call.name === "close")).toBe(false);
		expect(resumed.instance.registry.entries()).toEqual(snapshot.entries);
		expect(resumed.snapshots).toEqual([]);
	});

	it("reports replacement cleanup close failures and retains ownership for retry", async () => {
		const client = new FakeProcessClient();
		client.panes.add("w1:p2");
		client.failClose = true;
		const snapshot = { version: PROCESS_STATE_VERSION, entries: [owned()] } satisfies ProcessRegistrySnapshot;
		const resumed = manager(client);

		await expect(resumed.instance.rehydrate(snapshot, "resume"))
			.rejects.toThrow(/Could not close verified managed Pane.*ownership was retained/i);
		expect(client.calls.filter((call) => call.name === "close").map((call) => call.args[0]))
			.toEqual(["w1:p2"]);
		expect(resumed.instance.registry.entries()).toEqual(snapshot.entries);
	});

	it("leaves a visible orphan instead of closing by stale address when shutdown verification fails", async () => {
		const client = new FakeProcessClient();
		client.panes.add("w1:p2");
		client.failList = true;
		const snapshot = { version: PROCESS_STATE_VERSION, entries: [owned()] } satisfies ProcessRegistrySnapshot;
		const shuttingDown = manager(client, snapshot);

		await expect(shuttingDown.instance.shutdown("quit")).rejects.toThrow(/pane list unavailable/);
		expect(client.calls.some((call) => call.name === "close")).toBe(false);
		expect(client.panes.has("w1:p2")).toBe(true);
		expect(shuttingDown.instance.registry.entries()).toEqual(snapshot.entries);
	});
});

describe("tree navigation ownership rebind", () => {
	it("does not leave a partial union when a later branch entry collides", async () => {
		const client = new FakeProcessClient();
		const current = { version: PROCESS_STATE_VERSION, entries: [owned()] } satisfies ProcessRegistrySnapshot;
		const branch = {
			version: PROCESS_STATE_VERSION,
			entries: [
				owned({ paneId: "w1:p3", label: "preview" }),
				owned({ paneId: "w1:p2", terminalId: "term-collision", label: "collision" }),
			],
		} satisfies ProcessRegistrySnapshot;
		const { instance, snapshots } = manager(client, current);

		await expect(instance.rebindTree(branch, "session-1")).rejects.toThrow(/already registered/);
		expect(instance.registry.entries()).toEqual(current.entries);
		expect(snapshots).toEqual([]);
	});

	it("does not let an older branch's empty snapshot erase current live ownership", async () => {
		const client = new FakeProcessClient();
		client.panes.add("w1:p2");
		client.foreground.set("w1:p2", "running");
		const current = { version: 1, entries: [owned()] } satisfies ProcessRegistrySnapshot;
		const { instance, snapshots } = manager(client, current);
		const rebound = await instance.rebindTree({ version: 1, entries: [] }, "session-1");
		expect(rebound.entries.map((entry) => entry.paneId)).toEqual(["w1:p2"]);
		expect(snapshots.at(-1)?.entries.map((entry) => entry.paneId)).toEqual(["w1:p2"]);
	});

	it("merges matching branch ownership, preserves unknown, and removes only missing panes", async () => {
		const client = new FakeProcessClient();
		for (const paneId of ["w1:p2", "w1:p3", "w1:p4", "w1:p5"]) client.panes.add(paneId);
		for (const paneId of ["w1:p2", "w1:p3", "w1:p4"]) client.foreground.set(paneId, "running");
		const { instance } = manager(client, { version: 1, entries: [owned()] });
		const branch: ProcessRegistrySnapshot = {
			version: 1,
			entries: [
				owned({ paneId: "w1:p3", label: "preview" }),
				owned({ paneId: "w1:p4", label: "foreign", ownerSessionId: "other-session" }),
				owned({ paneId: "w1:p5", label: "unknown" }),
				owned({ paneId: "w1:p9", label: "dead" }),
			],
		};
		const rebound = await instance.rebindTree(branch, "session-1");
		expect(rebound.entries.map((entry) => entry.paneId)).toEqual(["w1:p2", "w1:p3", "w1:p5"]);
		expect(rebound.states).toMatchObject({ "w1:p2": "running", "w1:p3": "running", "w1:p5": "unknown" });
		expect(rebound.stale.map((entry) => entry.paneId)).toEqual(["w1:p9"]);
	});

	it("does not overwrite valid branch ownership with an empty current snapshot", async () => {
		const client = new FakeProcessClient();
		client.panes.add("w1:p3");
		client.failList = true;
		const branch = {
			version: 1,
			entries: [owned({ paneId: "w1:p3", label: "preview" })],
		} satisfies ProcessRegistrySnapshot;
		const { instance, snapshots } = manager(client);
		await expect(instance.rebindTree(branch, "session-1"))
			.rejects.toThrow(/pane list unavailable/);
		expect(instance.registry.entries().map((entry) => entry.paneId)).toEqual(["w1:p3"]);
		expect(snapshots.at(-1)?.entries.map((entry) => entry.paneId)).toEqual(["w1:p3"]);
	});

	it("persists the current-and-branch union before a transient live-list failure", async () => {
		const client = new FakeProcessClient();
		client.panes.add("w1:p2");
		client.panes.add("w1:p3");
		client.failList = true;
		const current = { version: 1, entries: [owned()] } satisfies ProcessRegistrySnapshot;
		const branch = {
			version: 1,
			entries: [owned({ paneId: "w1:p3", label: "preview" })],
		} satisfies ProcessRegistrySnapshot;
		const { instance, snapshots } = manager(client, current);
		await expect(instance.rebindTree(branch, "session-1"))
			.rejects.toThrow(/pane list unavailable/);
		expect(instance.registry.entries().map((entry) => entry.paneId)).toEqual(["w1:p2", "w1:p3"]);
		expect(snapshots.at(-1)?.entries.map((entry) => entry.paneId)).toEqual(["w1:p2", "w1:p3"]);
	});
});

describe("shutdown matrix", () => {
	const entries = [owned(), owned({ paneId: "w1:p3", label: "persistent", lifetime: "persistent" })];
	it.each(["quit", "new", "resume", "fork"] as const)("closes only session-owned on %s shutdown", (reason) => {
		expect(processEntriesToCloseOnShutdown(entries, reason).map((entry) => entry.paneId)).toEqual(["w1:p2"]);
	});
	it("keeps every process on reload", () => {
		expect(processEntriesToCloseOnShutdown(entries, "reload")).toEqual([]);
	});
	it.each(["new", "resume", "fork"] as const)("does not adopt copied session ownership on %s start", (reason) => {
		expect(processEntriesToCloseOnStart(entries, reason).map((entry) => entry.paneId)).toEqual(["w1:p2"]);
	});
	it.each(["startup", "reload"] as const)("rehydrates live ownership on %s start", (reason) => {
		expect(processEntriesToCloseOnStart(entries, reason)).toEqual([]);
	});
});
