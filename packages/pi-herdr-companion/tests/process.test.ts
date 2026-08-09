import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type CompanionConfig } from "../src/config.ts";
import {
	ProcessManager,
	classifyForegroundProcess,
	type ProcessClient,
} from "../src/process/manager.ts";
import { formatProcessList } from "../src/process/tool.ts";
import {
	PROCESS_OWNER,
	PROCESS_STATE_CUSTOM_TYPE,
	PROCESS_STATE_VERSION,
	ProcessRegistry,
	deriveProcessLabel,
	mayCloseOwnedProcess,
	processEntriesToCloseOnShutdown,
	processEntriesToCloseOnStart,
	restoreProcessRegistry,
	type ProcessEntry,
	type ProcessRegistrySnapshot,
} from "../src/process/registry.ts";

function config(): CompanionConfig {
	return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as CompanionConfig;
}

function owned(overrides: Partial<ProcessEntry> = {}): ProcessEntry {
	return {
		owner: PROCESS_OWNER,
		paneId: "w1:p2",
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
	foreground = new Map<string, FakeForeground>();
	calls: Array<{ name: string; args: unknown[] }> = [];
	output = "logs\n";
	failRun = false;
	failList = false;

	async splitPane(options: unknown) {
		this.calls.push({ name: "split", args: [options] });
		this.panes.add("w1:p2");
		return { paneId: "w1:p2" };
	}
	async listPanes() {
		this.calls.push({ name: "list", args: [] });
		if (this.failList) throw new Error("pane list unavailable");
		return [...this.panes].map((paneId) => ({ paneId }));
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
	async waitOutput(...args: [string, unknown]) {
		this.calls.push({ name: "wait", args });
		return "ready";
	}
	async readPane(...args: [string, number]) {
		this.calls.push({ name: "read", args });
		return this.output;
	}
	async closePane(paneId: string) {
		this.calls.push({ name: "close", args: [paneId] });
		this.panes.delete(paneId);
		this.foreground.delete(paneId);
	}
}

function manager(
	client = new FakeProcessClient(),
	initial?: ProcessRegistrySnapshot,
	clock: { now: Date } = { now: new Date("2026-08-09T12:00:00.000Z") },
) {
	const snapshots: ProcessRegistrySnapshot[] = [];
	const instance = new ProcessManager({
		client,
		runtime: { inside: true, paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", socketPath: "/tmp/herdr" },
		getConfig: config,
		persist: (snapshot) => snapshots.push(snapshot),
		now: () => clock.now,
		startGraceMs: 2_000,
	});
	if (initial) instance.registry.replace(initial);
	return { instance, client, snapshots, clock };
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
		expect(restoreProcessRegistry(entries)).toEqual(second);
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
		expect(entry).toMatchObject({ paneId: "w1:p2", label: "dev", lifetime: "session", owner: PROCESS_OWNER });
		expect(client.calls[1]).toMatchObject({
			name: "split",
			args: [{ target: "current", direction: "down", ratio: 0.35, cwd: "/work", focus: false }],
		});
		expect(client.calls.map((call) => call.name)).toEqual(["list", "split", "rename", "run", "wait"]);
		expect(snapshots.at(-1)?.entries).toEqual([entry]);
	});

	it("rejects a literal readiness marker echoed by the launch command before splitting", async () => {
		const { instance, client } = manager();
		await expect(instance.start(
			{ command: "node server.js --ready READY", readyMatch: "READY" },
			{ cwd: "/work", sessionId: "session-1" },
		)).rejects.toThrow(/shell echo.*anchored readyRegex/);
		expect(client.calls).toEqual([]);
	});

	it("closes a created orphan and records no ownership when launch fails", async () => {
		const client = new FakeProcessClient();
		client.failRun = true;
		const { instance, snapshots } = manager(client);
		await expect(instance.start({ command: "pnpm dev" }, { cwd: "/work", sessionId: "s" })).rejects.toThrow("run failed");
		expect(client.calls.at(-1)).toEqual({ name: "close", args: ["w1:p2"] });
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
		instance.registry.replace({ version: 1, entries: [owned({ paneId: "w1:p1", ownerPaneId: "w1:p9" })] });
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
		expect(instance.registry.entries()).toEqual(initial.entries);

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

	it("attempts replacement-session cleanup before a transient pane-list failure", async () => {
		const client = new FakeProcessClient();
		client.panes.add("w1:p2");
		client.failList = true;
		const snapshot = { version: 1, entries: [owned()] } satisfies ProcessRegistrySnapshot;
		const resumed = manager(client);
		await expect(resumed.instance.rehydrate(snapshot, "resume")).rejects.toThrow(/pane list unavailable/);
		expect(client.calls[0]).toEqual({ name: "close", args: ["w1:p2"] });
		expect(resumed.instance.registry.entries()).toEqual([]);
		expect(resumed.snapshots.at(-1)?.entries).toEqual([]);
	});
});

describe("tree navigation ownership rebind", () => {
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
