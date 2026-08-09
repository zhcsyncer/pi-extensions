import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { BtwContextStore } from "../src/btw/context-store.ts";
import { MergeCoordinator, type ParentMergePort } from "../src/btw/merge.ts";
import {
	MERGE_MESSAGE_CUSTOM_TYPE,
	MERGE_PHASE_CUSTOM_TYPE,
	MERGE_PROTOCOL_VERSION,
	type MergePhase,
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
		parentThinkingLevel: "high",
		messages: [{ role: "user", content: [{ type: "text", text: "parent" }], timestamp: 0 } as never],
		draftQuestion: "question",
		config: { ...DEFAULT_CONFIG.btw },
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

class FakeParentSession implements ParentMergePort {
	entries: SessionEntry[] = [];
	idle = true;
	autoPersistPrompt = true;
	submitCalls: string[] = [];
	appendCalls = 0;
	notifications: Array<{ message: string; type: string }> = [];
	private nextId = 0;
	private leaf: string | null = null;

	getSessionId() { return "session-1"; }
	isIdle() { return this.idle; }
	getEntries() { return [...this.entries]; }
	appendMergeMessage(content: string, details: { requestId: string; launchId: string }) {
		this.appendCalls += 1;
		this.append({
			type: "custom_message",
			customType: MERGE_MESSAGE_CUSTOM_TYPE,
			content,
			display: true,
			details,
		} as Omit<Extract<SessionEntry, { type: "custom_message" }>, "id" | "parentId" | "timestamp">);
	}
	submitPrompt(prompt: string) {
		this.submitCalls.push(prompt);
		if (this.autoPersistPrompt) this.persistUserPrompt(prompt);
	}
	persistPhase(data: { requestId: string; launchId: string; phase: MergePhase; prompt: string; updatedAt: string }) {
		this.append({
			type: "custom",
			customType: MERGE_PHASE_CUSTOM_TYPE,
			data,
		} as Omit<Extract<SessionEntry, { type: "custom" }>, "id" | "parentId" | "timestamp">);
	}
	notify(message: string, type: "info" | "warning" | "error") {
		this.notifications.push({ message, type });
	}
	persistUserPrompt(prompt: string) {
		this.append({
			type: "message",
			message: { role: "user", content: [{ type: "text", text: prompt }], timestamp: 0 },
		} as Omit<Extract<SessionEntry, { type: "message" }>, "id" | "parentId" | "timestamp">);
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

function phases(session: FakeParentSession): MergePhase[] {
	return session.entries
		.filter((entry): entry is Extract<SessionEntry, { type: "custom" }> => entry.type === "custom" && entry.customType === MERGE_PHASE_CUSTOM_TYPE)
		.map((entry) => (entry.data as { phase: MergePhase }).phase);
}

describe("durable parent merge coordinator", () => {
	it("delivers message, observes durable prompt, then records message_appended → prompt_submitted → acked", async () => {
		const { store, path } = await setup();
		const session = new FakeParentSession();
		const coordinator = new MergeCoordinator(store, session, () => new Date("2026-08-09T12:00:01.000Z"));
		expect(await coordinator.scan()).toEqual({ delivered: 0, deferred: 1, rejected: 0 });
		expect(session.appendCalls).toBe(1);
		expect(session.submitCalls).toEqual(["Continue with the side-thread finding."]);
		expect(await store.readMergeAck(path)).toBeUndefined();

		expect(await coordinator.scan()).toEqual({ delivered: 1, deferred: 0, rejected: 0 });
		expect(session.appendCalls).toBe(1);
		expect(session.submitCalls).toHaveLength(1);
		expect(phases(session)).toEqual(["message_appended", "prompt_submitted", "acked"]);
		expect(await store.readMergeAck(path)).toMatchObject({ requestId: "request-1", status: "accepted" });
		expect((await store.readMergeState(path))?.phase).toBe("acked");
	});

	it("defers every side effect while the parent is busy", async () => {
		const { store } = await setup();
		const session = new FakeParentSession();
		session.idle = false;
		const result = await new MergeCoordinator(store, session).scan();
		expect(result).toEqual({ delivered: 0, deferred: 1, rejected: 0 });
		expect(session.appendCalls).toBe(0);
		expect(session.submitCalls).toEqual([]);
	});

	it("uses file locking and a dispatch lease across two parent instances", async () => {
		const { store } = await setup();
		const session = new FakeParentSession();
		session.autoPersistPrompt = false;
		const first = new MergeCoordinator(store, session, () => new Date("2026-08-09T12:00:01.000Z"));
		const second = new MergeCoordinator(store, session, () => new Date("2026-08-09T12:00:01.100Z"));
		await Promise.all([first.scan(), second.scan()]);
		expect(session.appendCalls).toBe(1);
		expect(session.submitCalls).toHaveLength(1);
		expect((await store.readMergeState((await store.listLaunchPayloadPaths())[0]!))?.dispatch).toBeDefined();
	});

	it("recovers after message append without appending it twice", async () => {
		const { store } = await setup();
		const session = new FakeParentSession();
		session.autoPersistPrompt = false;
		session.appendMergeMessage("already merged", { requestId: "request-1", launchId: "launch-1" });
		const coordinator = new MergeCoordinator(store, session);
		await coordinator.scan();
		expect(session.appendCalls).toBe(1);
		expect(session.submitCalls).toHaveLength(1);
	});

	it("recovers a prompt persisted before ack without resubmitting a paid turn", async () => {
		const { store, path, merge } = await setup();
		const session = new FakeParentSession();
		session.appendMergeMessage("already merged", { requestId: merge.requestId, launchId: merge.launchId });
		session.persistUserPrompt(merge.prompt);
		const result = await new MergeCoordinator(store, session).scan();
		expect(result.delivered).toBe(1);
		expect(session.submitCalls).toEqual([]);
		expect(await store.readMergeAck(path)).toMatchObject({ status: "accepted" });
	});

	it("retries only after an expired dispatch lease and still deduplicates the merge message", async () => {
		const { store } = await setup();
		const session = new FakeParentSession();
		session.autoPersistPrompt = false;
		await new MergeCoordinator(store, session, () => new Date("2026-08-09T12:00:00.000Z"), 10_000).scan();
		expect(session.submitCalls).toHaveLength(1);
		await new MergeCoordinator(store, session, () => new Date("2026-08-09T12:00:05.000Z"), 10_000).scan();
		expect(session.submitCalls).toHaveLength(1);
		await new MergeCoordinator(store, session, () => new Date("2026-08-09T12:00:20.000Z"), 10_000).scan();
		expect(session.submitCalls).toHaveLength(2);
		expect(session.appendCalls).toBe(1);
	});

	it("rejects capability mismatch without injecting either message or prompt", async () => {
		const value = payload();
		const { store, path } = await setup(value, request(value, { capability: "x".repeat(64) }));
		const session = new FakeParentSession();
		const result = await new MergeCoordinator(store, session).scan();
		expect(result.rejected).toBe(1);
		expect(session.appendCalls).toBe(0);
		expect(session.submitCalls).toEqual([]);
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
