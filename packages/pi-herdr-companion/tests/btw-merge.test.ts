import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { BtwContextStore } from "../src/btw/context-store.ts";
import { MergeCoordinator, type ParentMergePort } from "../src/btw/merge.ts";
import {
	MERGE_MESSAGE_CUSTOM_TYPE,
	MERGE_PROTOCOL_VERSION,
	type MergeRequest,
} from "../src/btw/protocol.ts";
import { createBtwPayload, type BtwPayload } from "../src/btw/types.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function payload(overrides: Partial<BtwPayload> = {}): BtwPayload {
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
		launchId: "launch-1",
		capability: "c".repeat(64),
		...overrides,
	});
}

function request(value: BtwPayload, overrides: Partial<MergeRequest> = {}): MergeRequest {
	return {
		protocolVersion: MERGE_PROTOCOL_VERSION,
		requestId: "request-1",
		launchId: value.launchId,
		parentSessionId: value.parentSessionId,
		capability: value.capability,
		createdAt: value.createdAt,
		summary: "User:\nquestion\n\nAssistant:\nanswer",
		prompt: "Continue with the side-thread finding.",
		...overrides,
	};
}

interface DispatchCall {
	content: string;
	details: { requestId: string; launchId: string };
}

class FakeParentSession implements ParentMergePort {
	entries: SessionEntry[] = [];
	idle = true;
	dispatchCalls: DispatchCall[] = [];
	notifications: Array<{ message: string; type: string }> = [];
	private nextId = 0;
	private leaf: string | null = null;

	getSessionId() { return "session-1"; }
	isIdle() { return this.idle; }
	getEntries() { return [...this.entries]; }
	dispatchMergeMessage(content: string, details: { requestId: string; launchId: string }) {
		// Deliberately do not append synchronously. Pi 0.84's ExtensionAPI wrapper
		// returns before sendCustomMessage has either persisted or failed.
		this.dispatchCalls.push({ content, details });
	}
	notify(message: string, type: "info" | "warning" | "error") {
		this.notifications.push({ message, type });
	}
	persistEvidence(call = this.dispatchCalls.at(-1)) {
		if (!call) throw new Error("No dispatched message to persist");
		this.append({
			type: "custom_message",
			customType: MERGE_MESSAGE_CUSTOM_TYPE,
			content: call.content,
			display: true,
			details: call.details,
		} as Omit<Extract<SessionEntry, { type: "custom_message" }>, "id" | "parentId" | "timestamp">);
	}
	private append(entry: Omit<SessionEntry, "id" | "parentId" | "timestamp">) {
		const id = `e${++this.nextId}`;
		const full = { ...entry, id, parentId: this.leaf, timestamp: new Date().toISOString() } as SessionEntry;
		this.entries.push(full);
		this.leaf = id;
	}
}

async function setup(value = payload(), merge = request(value)) {
	const root = await mkdtemp(join(tmpdir(), "companion-merge-"));
	roots.push(root);
	const store = new BtwContextStore(join(root, "state"));
	const path = await store.create(value);
	await store.createMergeRequest(path, merge);
	return { store, path, value, merge };
}

describe("durable parent merge coordinator", () => {
	it("acks only after asynchronous custom-message evidence and carries transcript plus follow-up", async () => {
		const { store, path } = await setup();
		const session = new FakeParentSession();
		const coordinator = new MergeCoordinator(store, session, () => new Date("2026-08-09T12:00:01.000Z"));

		expect(await coordinator.scan()).toEqual({ delivered: 0, deferred: 1, rejected: 0 });
		expect(session.dispatchCalls).toHaveLength(1);
		expect(session.dispatchCalls[0]).toMatchObject({
			content: expect.stringContaining("<btw-merge>"),
			details: { requestId: "request-1", launchId: "launch-1" },
		});
		expect(session.dispatchCalls[0]?.content).toContain("Continue with the side-thread finding.");
		expect(await store.readMergeAck(path)).toBeUndefined();

		// A scan before evidence neither acks nor immediately retransmits.
		expect(await coordinator.scan()).toEqual({ delivered: 0, deferred: 1, rejected: 0 });
		expect(session.dispatchCalls).toHaveLength(1);
		expect(await store.readMergeAck(path)).toBeUndefined();

		session.persistEvidence();
		expect(await coordinator.scan()).toEqual({ delivered: 1, deferred: 0, rejected: 0 });
		expect(session.dispatchCalls).toHaveLength(1);
		expect(await store.readMergeAck(path)).toMatchObject({ requestId: "request-1", status: "accepted" });
		expect((await store.readMergeState(path))?.phase).toBe("acked");
	});

	it("defers every dispatch while the parent is busy", async () => {
		const { store } = await setup();
		const session = new FakeParentSession();
		session.idle = false;
		const result = await new MergeCoordinator(store, session).scan();
		expect(result).toEqual({ delivered: 0, deferred: 1, rejected: 0 });
		expect(session.dispatchCalls).toEqual([]);
	});

	it("serializes concurrent scans under one active parent owner", async () => {
		const { store } = await setup();
		const session = new FakeParentSession();
		const first = new MergeCoordinator(store, session, () => new Date("2026-08-09T12:00:01.000Z"));
		const second = new MergeCoordinator(store, session, () => new Date("2026-08-09T12:00:01.100Z"));
		await Promise.all([first.scan(), second.scan()]);
		expect(session.dispatchCalls).toHaveLength(1);
		expect((await store.readMergeState((await store.listLaunchPayloadPaths())[0]!))?.dispatch).toBeDefined();
	});

	it("recovers from durable request-tagged evidence without redispatch", async () => {
		const { store, merge } = await setup();
		const session = new FakeParentSession();
		session.dispatchCalls.push({
			content: "already merged",
			details: { requestId: merge.requestId, launchId: merge.launchId },
		});
		session.persistEvidence();
		session.dispatchCalls.length = 0;
		const result = await new MergeCoordinator(store, session).scan();
		expect(result.delivered).toBe(1);
		expect(session.dispatchCalls).toEqual([]);
	});

	it("retries only after an expired dispatch lease", async () => {
		const { store } = await setup();
		const session = new FakeParentSession();
		await new MergeCoordinator(store, session, () => new Date("2026-08-09T12:00:00.000Z"), 10_000).scan();
		expect(session.dispatchCalls).toHaveLength(1);
		await new MergeCoordinator(store, session, () => new Date("2026-08-09T12:00:05.000Z"), 10_000).scan();
		expect(session.dispatchCalls).toHaveLength(1);
		await new MergeCoordinator(store, session, () => new Date("2026-08-09T12:00:20.000Z"), 10_000).scan();
		expect(session.dispatchCalls).toHaveLength(2);
		expect(await store.readMergeAck((await store.listLaunchPayloadPaths())[0]!)).toBeUndefined();
	});

	it("ignores evidence tagged for a different request", async () => {
		const { store, path } = await setup();
		const session = new FakeParentSession();
		session.dispatchCalls.push({ content: "other", details: { requestId: "request-other", launchId: "launch-1" } });
		session.persistEvidence();
		session.dispatchCalls.length = 0;
		await new MergeCoordinator(store, session).scan();
		expect(session.dispatchCalls).toHaveLength(1);
		expect(await store.readMergeAck(path)).toBeUndefined();
	});

	it("rejects capability mismatch without injecting a message", async () => {
		const value = payload();
		const { store, path } = await setup(value, request(value, { capability: "x".repeat(64) }));
		const session = new FakeParentSession();
		const result = await new MergeCoordinator(store, session).scan();
		expect(result.rejected).toBe(1);
		expect(session.dispatchCalls).toEqual([]);
		expect(await store.readMergeAck(path)).toMatchObject({ status: "rejected", reason: "capability mismatch" });
	});

	it("leaves requests for another exact parent session untouched", async () => {
		const value = payload({ parentSessionId: "another-session" });
		const { store, path } = await setup(value, request(value));
		const session = new FakeParentSession();
		expect(await new MergeCoordinator(store, session).scan()).toEqual({ delivered: 0, deferred: 0, rejected: 0 });
		expect(await store.readMergeAck(path)).toBeUndefined();
	});
});
