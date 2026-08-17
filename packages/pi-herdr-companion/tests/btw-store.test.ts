import { access, chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindChildSession } from "../src/btw/child.ts";
import { BtwContextStore, defaultBtwStateRoot } from "../src/btw/context-store.ts";
import { LAUNCH_STATE_FILE, MERGE_PROTOCOL_VERSION, type MergeRequest } from "../src/btw/protocol.ts";
import { createBtwPayload, type BtwPayload } from "../src/btw/types.ts";

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

	it("never reclaims a stale-looking candidate while its owner PID is alive", async () => {
		const { store } = await makeStore();
		const path = await store.create(payload("launch-a"));
		const lockPath = join(dirname(path), ".delivery.lock.123.live-candidate");
		await writeFile(lockPath, `${JSON.stringify({ pid: 123, ticket: "0", createdAt: "old" })}\n`, { mode: 0o600 });
		const old = new Date("2026-08-01T00:00:00.000Z");
		await utimes(lockPath, old, old);
		const guarded = new BtwContextStore(store.root, {
			lockWaitMs: 40,
			staleLockMs: 1,
			isProcessAlive: async (pid) => pid === 123,
		});
		await expect(guarded.withDeliveryLock(path, async () => undefined)).rejects.toThrow(/Timed out/);
		expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ pid: 123, ticket: "0" });
	});

	it("elects only one owner when two waiters reclaim the same dead candidate", async () => {
		const { store } = await makeStore();
		const path = await store.create(payload("launch-a"));
		const stalePath = join(dirname(path), ".delivery.lock.999999.dead-candidate");
		await writeFile(stalePath, `${JSON.stringify({ pid: 999999, ticket: "0", createdAt: "old" })}\n`, { mode: 0o600 });
		const old = new Date("2026-08-01T00:00:00.000Z");
		await utimes(stalePath, old, old);

		let arrived = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const options = {
			lockWaitMs: 500,
			staleLockMs: 1,
			isProcessAlive: async (pid: number) => pid === process.pid,
			beforeLockElection: async () => {
				arrived += 1;
				if (arrived === 2) release();
				await gate;
			},
		};
		const stores = [new BtwContextStore(store.root, options), new BtwContextStore(store.root, options)];
		let concurrent = 0;
		let maximum = 0;
		await Promise.all(stores.map((candidate) => candidate.withDeliveryLock(path, async () => {
			concurrent += 1;
			maximum = Math.max(maximum, concurrent);
			await new Promise((resolve) => setTimeout(resolve, 30));
			concurrent -= 1;
		})));
		expect(maximum).toBe(1);
		await expect(access(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("serializes child-ready and first-session binding without losing identity", async () => {
		const { store } = await makeStore();
		const value = payload("launch-bind");
		const path = await store.create(value);
		await store.mutateLaunchState(path, (current) => ({
			...current!,
			status: "pane_created",
			paneId: "w1:p2",
			agentName: "btw-launch-bind",
			updatedAt: value.createdAt,
		}));
		const [binding] = await Promise.all([
			bindChildSession(store, path, value, "child-session-1"),
			store.mutateLaunchState(path, (current) => ({
				...current!,
				status: "child_ready",
				updatedAt: new Date().toISOString(),
			})),
		]);
		expect(binding.bound).toBe(true);
		expect(await store.readLaunchState(path)).toMatchObject({
			status: "child_ready",
			childSessionId: "child-session-1",
			paneId: "w1:p2",
		});
	});

	it("allows only one of two concurrent child sessions to bind", async () => {
		const { store } = await makeStore();
		const value = payload("launch-bind-race");
		const path = await store.create(value);
		const results = await Promise.all([
			bindChildSession(store, path, value, "child-session-a"),
			bindChildSession(store, path, value, "child-session-b"),
		]);
		expect(results.filter((result) => result.bound)).toHaveLength(1);
		expect(results.filter((result) => !result.bound)).toHaveLength(1);
		expect(["child-session-a", "child-session-b"]).toContain((await store.readLaunchState(path))?.childSessionId);
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

	it("removes a private launch only after its request has a matching acknowledgement", async () => {
		const { store } = await makeStore();
		const value = payload("launch-a");
		const path = await store.create(value);
		const pending = request(value, "request-1");
		await store.createMergeRequest(path, pending);
		expect(await store.removeIfNoPendingMerge(path)).toBe(false);
		await expect(access(path)).resolves.toBeUndefined();

		await store.writeMergeAck(path, {
			protocolVersion: 1,
			requestId: "request-other",
			status: "accepted",
			processedAt: new Date().toISOString(),
		});
		expect(await store.removeIfNoPendingMerge(path)).toBe(false);
		await expect(access(path)).resolves.toBeUndefined();

		await store.writeMergeAck(path, {
			protocolVersion: 1,
			requestId: pending.requestId,
			status: "accepted",
			processedAt: new Date().toISOString(),
		});
		expect(await store.removeIfNoPendingMerge(path)).toBe(true);
		await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("preserves private launch evidence when mailbox confirmation is unreadable", async () => {
		const { store } = await makeStore();
		const value = payload("launch-a");
		const path = await store.create(value);
		await store.createMergeRequest(path, request(value, "request-1"));
		await writeFile(join(dirname(path), "merge-request.json"), "{", { mode: 0o600 });

		await expect(store.removeIfNoPendingMerge(path)).rejects.toThrow();
		await expect(access(path)).resolves.toBeUndefined();
	});

	it("uses launch-state time while preserving live, recent, and pending launches", async () => {
		const { store } = await makeStore();
		const liveValue = payload("launch-live");
		const pendingValue = payload("launch-pending");
		const deadValue = payload("launch-dead");
		const recentValue = payload("launch-recent");
		const live = await store.create(liveValue);
		const pending = await store.create(pendingValue);
		const dead = await store.create(deadValue);
		const recent = await store.create(recentValue);
		for (const [path, value, paneId, updatedAt] of [
			[live, liveValue, "w1:p2", "2026-08-01T00:00:00.000Z"],
			[pending, pendingValue, "w1:p3", "2026-08-01T00:00:00.000Z"],
			[dead, deadValue, "w1:p4", "2026-08-01T00:00:00.000Z"],
			[recent, recentValue, "w1:p5", "2026-08-08T23:59:30.000Z"],
		] as const) {
			await store.writeLaunchState(path, {
				version: 1,
				launchId: value.launchId,
				paneId,
				agentName: `btw-${value.launchId}`,
				status: "child_ready",
				updatedAt,
			});
		}
		await store.createMergeRequest(pending, request(pendingValue));
		await utimes(dirname(dead), new Date("2026-08-09T00:00:00.000Z"), new Date("2026-08-09T00:00:00.000Z"));
		await utimes(dirname(recent), new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-01T00:00:00.000Z"));
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
		await expect(access(recent)).resolves.toBeUndefined();
	});

	it.each(["missing", "malformed"] as const)("preserves stale launch evidence when launch state is %s", async (kind) => {
		const { store } = await makeStore();
		const path = await store.create(payload(`launch-${kind}`));
		const statePath = join(dirname(path), LAUNCH_STATE_FILE);
		if (kind === "missing") await rm(statePath);
		else await writeFile(statePath, "{", { mode: 0o600 });
		const old = new Date("2026-08-01T00:00:00.000Z");
		await utimes(dirname(path), old, old);
		const removed = await store.removeStale({
			now: new Date("2026-08-09T00:00:00.000Z").getTime(),
			maxAgeMs: 60_000,
			isPaneLive: async () => { throw new Error("identity is unavailable"); },
		});
		expect(removed).toEqual([]);
		await expect(access(path)).resolves.toBeUndefined();
	});

	it("uses separate state namespaces for separate Herdr sockets", () => {
		const agentDir = "/agent";
		expect(defaultBtwStateRoot({ inside: true, socketPath: "/tmp/a" }, agentDir))
			.not.toBe(defaultBtwStateRoot({ inside: true, socketPath: "/tmp/b" }, agentDir));
	});
});
