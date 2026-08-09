import { access, chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BtwContextStore, defaultBtwStateRoot } from "../src/btw/context-store.ts";
import { MERGE_PROTOCOL_VERSION, type MergeRequest } from "../src/btw/protocol.ts";
import { createBtwPayload, type BtwPayload } from "../src/btw/types.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function payload(id: string): BtwPayload {
	return createBtwPayload({
		createdAt: "2026-08-09T12:00:00.000Z",
		parentSessionId: "session-1",
		parentPaneId: "w1:p1",
		metadata: { generatedAt: "2026-08-09T12:00:00.000Z", cwd: "/work", session: "s", model: "openai/gpt" },
		parentSystemPrompt: "system",
		parentActiveTools: ["read"],
		parentToolSchemaFingerprint: "tools-v1",
		parentThinkingLevel: "high",
		messages: [{ role: "user", content: [{ type: "text", text: "parent" }], timestamp: 0 } as never],
		draftQuestion: "question",
		config: { ...DEFAULT_CONFIG.btw },
		launchId: id,
		capability: id.padEnd(64, "c"),
	});
}

function request(value: BtwPayload, id = `request-${value.launchId}`): MergeRequest {
	return {
		protocolVersion: MERGE_PROTOCOL_VERSION,
		requestId: id,
		launchId: value.launchId,
		parentSessionId: value.parentSessionId,
		capability: value.capability,
		createdAt: value.createdAt,
		summary: "side summary",
		prompt: "continue",
	};
}

async function makeStore() {
	const root = await mkdtemp(join(tmpdir(), "companion-btw-store-"));
	roots.push(root);
	const stateRoot = join(root, "state");
	return { store: new BtwContextStore(stateRoot), stateRoot };
}

describe("private BTW state store", () => {
	it("creates 0700 roots/launches and 0600 payload/mailbox files", async () => {
		const { store, stateRoot } = await makeStore();
		const value = payload("launch-a");
		const path = await store.create(value);
		expect(await store.read(path)).toEqual(value);
		await store.createMergeRequest(path, request(value));
		if (process.platform !== "win32") {
			expect((await stat(stateRoot)).mode & 0o777).toBe(0o700);
			expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			expect((await stat(join(dirname(path), "merge-request.json"))).mode & 0o777).toBe(0o600);
		}
	});

	it("refuses group-readable state instead of trusting a shared payload", async () => {
		if (process.platform === "win32") return;
		const { store } = await makeStore();
		const path = await store.create(payload("launch-a"));
		await chmod(path, 0o640);
		await expect(store.read(path)).rejects.toThrow(/group or other permissions/);
	});

	it("uses a lock/CAS boundary so only one delivery mutation is in flight", async () => {
		const { store } = await makeStore();
		const path = await store.create(payload("launch-a"));
		const order: string[] = [];
		let release!: () => void;
		const held = new Promise<void>((resolve) => { release = resolve; });
		let entered!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		const first = store.withDeliveryLock(path, async () => {
			order.push("first-enter");
			entered();
			await held;
			order.push("first-exit");
		});
		await started;
		const second = store.withDeliveryLock(path, async () => {
			order.push("second-enter");
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(order).toEqual(["first-enter"]);
		release();
		await Promise.all([first, second]);
		expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
	});

	it("never reclaims a stale-looking lock while its owner PID is alive", async () => {
		const { store } = await makeStore();
		const path = await store.create(payload("launch-a"));
		const lockPath = join(dirname(path), ".delivery.lock");
		await writeFile(lockPath, `${JSON.stringify({ token: "live-token", pid: 123, createdAt: "old" })}\n`, { mode: 0o600 });
		const old = new Date("2026-08-01T00:00:00.000Z");
		await utimes(lockPath, old, old);
		const guarded = new BtwContextStore(store.root, {
			lockWaitMs: 40,
			staleLockMs: 1,
			isProcessAlive: async (pid) => pid === 123,
		});
		await expect(guarded.withDeliveryLock(path, async () => undefined)).rejects.toThrow(/Timed out/);
		expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ token: "live-token" });
	});

	it("does not delete a replacement lock after observing an older stale inode", async () => {
		const { store } = await makeStore();
		const path = await store.create(payload("launch-a"));
		const lockPath = join(dirname(path), ".delivery.lock");
		await writeFile(lockPath, `${JSON.stringify({ token: "old-token", pid: 123, createdAt: "old" })}\n`, { mode: 0o600 });
		const old = new Date("2026-08-01T00:00:00.000Z");
		await utimes(lockPath, old, old);
		let replaced = false;
		const guarded = new BtwContextStore(store.root, {
			lockWaitMs: 60,
			staleLockMs: 1,
			isProcessAlive: async (pid) => pid === process.pid,
			beforeStaleLockRecheck: async () => {
				if (replaced) return;
				replaced = true;
				await rm(lockPath, { force: true });
				await writeFile(lockPath, `${JSON.stringify({ token: "replacement-token", pid: process.pid, createdAt: "new" })}\n`, { mode: 0o600 });
			},
		});
		await expect(guarded.withDeliveryLock(path, async () => undefined)).rejects.toThrow(/Timed out/);
		expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ token: "replacement-token", pid: process.pid });
	});

	it("does not overwrite an unacknowledged request but allows a new request after ack", async () => {
		const { store } = await makeStore();
		const value = payload("launch-a");
		const path = await store.create(value);
		const first = request(value, "request-1");
		await store.createMergeRequest(path, first);
		await expect(store.createMergeRequest(path, request(value, "request-2"))).rejects.toThrow(/already pending/);
		await store.writeMergeAck(path, {
			protocolVersion: 1,
			requestId: first.requestId,
			status: "accepted",
			processedAt: new Date().toISOString(),
		});
		await store.createMergeRequest(path, request(value, "request-2"));
		expect((await store.readMergeRequest(path) as MergeRequest).requestId).toBe("request-2");
		expect(await store.readMergeAck(path)).toBeUndefined();
	});

	it("stale cleanup preserves live panes and pending merges, deleting only confirmed-dead settled launches", async () => {
		const { store } = await makeStore();
		const liveValue = payload("launch-live");
		const pendingValue = payload("launch-pending");
		const deadValue = payload("launch-dead");
		const live = await store.create(liveValue);
		const pending = await store.create(pendingValue);
		const dead = await store.create(deadValue);
		for (const [path, value, paneId] of [
			[live, liveValue, "w1:p2"],
			[pending, pendingValue, "w1:p3"],
			[dead, deadValue, "w1:p4"],
		] as const) {
			await store.writeLaunchState(path, {
				version: 1,
				launchId: value.launchId,
				paneId,
				agentName: `btw-${value.launchId}`,
				status: "child_ready",
				updatedAt: "2026-08-09T12:00:00.000Z",
			});
		}
		await store.createMergeRequest(pending, request(pendingValue));
		const old = new Date("2026-08-01T00:00:00.000Z");
		await Promise.all([live, pending, dead].map((path) => utimes(dirname(path), old, old)));
		const removed = await store.removeStale({
			now: new Date("2026-08-09T00:00:00.000Z").getTime(),
			maxAgeMs: 60_000,
			isPaneLive: async (paneId, agentName) => {
				expect(agentName).toBeDefined();
				return paneId === "w1:p2" ? true : false;
			},
		});
		expect(removed).toEqual([dead]);
		await expect(access(live)).resolves.toBeUndefined();
		await expect(access(pending)).resolves.toBeUndefined();
		await expect(access(dead)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("uses separate state namespaces for separate Herdr sockets", () => {
		const agentDir = "/agent";
		expect(defaultBtwStateRoot({ inside: true, socketPath: "/tmp/a" }, agentDir))
			.not.toBe(defaultBtwStateRoot({ inside: true, socketPath: "/tmp/b" }, agentDir));
	});
});
