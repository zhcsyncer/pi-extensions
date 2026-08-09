import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type CompanionConfig } from "../src/config.ts";
import { ProcessManager, type ProcessClient } from "../src/process/manager.ts";
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

class FakeProcessClient implements ProcessClient {
	panes = new Set(["w1:p1"]);
	calls: Array<{ name: string; args: unknown[] }> = [];
	output = "logs\n";
	failRun = false;

	async splitPane(options: unknown) {
		this.calls.push({ name: "split", args: [options] });
		this.panes.add("w1:p2");
		return { paneId: "w1:p2" };
	}
	async listPanes() {
		this.calls.push({ name: "list", args: [] });
		return [...this.panes].map((paneId) => ({ paneId }));
	}
	async renamePane(...args: [string, string]) {
		this.calls.push({ name: "rename", args });
	}
	async runPane(...args: [string, string]) {
		this.calls.push({ name: "run", args });
		if (this.failRun) throw new Error("run failed");
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
	}
}

function manager(client = new FakeProcessClient(), initial?: ProcessRegistrySnapshot) {
	const snapshots: ProcessRegistrySnapshot[] = [];
	const instance = new ProcessManager({
		client,
		runtime: { inside: true, paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", socketPath: "/tmp/herdr" },
		getConfig: config,
		persist: (snapshot) => snapshots.push(snapshot),
		now: () => new Date("2026-08-09T12:00:00.000Z"),
	});
	if (initial) instance.registry.replace(initial);
	return { instance, client, snapshots };
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
});

describe("process manager behavior", () => {
	it("starts down/no-focus at ratio 0.35, waits for readiness, then durably owns the pane", async () => {
		const { instance, client, snapshots } = manager();
		const entry = await instance.start({ command: "pnpm dev", readyMatch: "ready" }, { cwd: "/work", sessionId: "session-1" });
		expect(entry).toMatchObject({ paneId: "w1:p2", label: "dev", lifetime: "session", owner: PROCESS_OWNER });
		expect(client.calls[1]).toMatchObject({
			name: "split",
			args: [{ target: "current", direction: "down", ratio: 0.35, cwd: "/work", focus: false }],
		});
		expect(client.calls.map((call) => call.name)).toEqual(["list", "split", "rename", "run", "wait"]);
		expect(snapshots.at(-1)?.entries).toEqual([entry]);
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
