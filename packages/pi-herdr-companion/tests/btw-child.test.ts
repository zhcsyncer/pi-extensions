import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { registerBtwChild, type ChildStorePort } from "../src/btw/child.ts";
import { fingerprintActiveToolSchemas, fingerprintSystemPrompt } from "../src/btw/cache-mode.ts";
import { createBtwPayload, type BtwPayload } from "../src/btw/types.ts";
import type { LaunchState, MergeAck, MergeRequest } from "../src/btw/protocol.ts";

const tools = [{
	name: "read",
	description: "Read files",
	parameters: { type: "object", properties: { path: { type: "string" } } },
	promptGuidelines: ["Use read for files."],
	sourceInfo: { path: "<builtin:read>", source: "builtin", scope: "temporary", origin: "top-level" },
}] as unknown as ToolInfo[];

function payload(): BtwPayload {
	return createBtwPayload({
		createdAt: "2026-08-09T12:00:00.000Z",
		parentSessionId: "parent-session",
		parentPaneId: "w1:p1",
		metadata: { generatedAt: "2026-08-09T12:00:00.000Z", cwd: "/work", session: "parent.jsonl", model: "openai/gpt" },
		parentSystemPrompt: "parent system",
		parentSystemPromptFingerprint: fingerprintSystemPrompt("parent system"),
		parentActiveTools: ["read"],
		parentToolSchemaFingerprint: fingerprintActiveToolSchemas(["read"], tools),
		parentThinkingLevel: "high",
		messages: [{ role: "user", content: [{ type: "text", text: "parent context" }], timestamp: 0 } as never],
		draftQuestion: "",
		config: { ...DEFAULT_CONFIG.btw },
		launchId: "launch-child",
		capability: "c".repeat(64),
	});
}

class FakeStore implements ChildStorePort {
	request?: MergeRequest;
	ack?: MergeAck;
	removed = 0;
	writes: LaunchState[] = [];
	constructor(readonly value: BtwPayload, public state: LaunchState) {}
	async read() { return this.value; }
	async readLaunchState() { return this.state; }
	async writeLaunchState(_path: string, state: LaunchState) { this.state = state; this.writes.push(state); }
	async readMergeRequest() { return this.request; }
	async readMergeAck() { return this.ack; }
	async createMergeRequest(_path: string, request: MergeRequest) { this.request = request; }
	async removeIfNoPendingMerge() { this.removed += 1; return true; }
}

function harness() {
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const commands = new Map<string, { handler(args: string, ctx: any): unknown }>();
	const sentUserMessages: unknown[] = [];
	const pi = {
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const current = handlers.get(name) ?? [];
			current.push(handler as never);
			handlers.set(name, current);
		},
		registerCommand(name: string, definition: { handler(args: string, ctx: unknown): unknown }) {
			commands.set(name, definition as never);
		},
		getActiveTools: () => ["read"],
		getAllTools: () => tools,
		getThinkingLevel: () => "high",
		sendUserMessage(value: unknown) { sentUserMessages.push(value); },
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands, sentUserMessages };
}

function context(sessionId: string) {
	const notifications: Array<{ message: string; type: string }> = [];
	return {
		ctx: {
			mode: "tui",
			model: { provider: "openai", id: "gpt" },
			sessionManager: {
				getSessionId: () => sessionId,
				getEntries: () => [],
				getLeafId: () => null,
			},
			ui: {
				notify(message: string, type: string) { notifications.push({ message, type }); },
				setTitle() {},
				setWidget() {},
				setEditorText() {},
				editor: async () => undefined,
				theme: { fg: (_name: string, text: string) => text },
			},
		},
		notifications,
	};
}

async function emit(
	handlers: Map<string, Array<(event: any, ctx: any) => any>>,
	name: string,
	event: unknown,
	ctx: unknown,
) {
	const results = [];
	for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
	return results;
}

describe("BTW child session lifecycle", () => {
	it("disables replay, merge, ack cleanup, and launch draft after /new changes the session ID", async () => {
		const value = payload();
		const store = new FakeStore(value, {
			version: 1,
			launchId: value.launchId,
			paneId: "w1:p2",
			agentName: "btw-child",
			childSessionId: "first-child-session",
			status: "child_ready",
			updatedAt: value.createdAt,
		});
		const h = harness();
		await registerBtwChild(h.pi, {
			store,
			client: {
				async getAgent() { return { paneId: "w1:p2" }; },
				async focusAgent() {},
				async closePane() {},
			},
			payloadPath: "/private/payload.json",
			runtime: { inside: true, paneId: "w1:p2", socketPath: "/tmp/herdr" },
		});
		const { ctx, notifications } = context("unrelated-new-session");
		await emit(h.handlers, "session_start", { reason: "new" }, ctx);
		expect(notifications.at(-1)?.message).toContain("Parent context will not be replayed or merged");
		expect((await emit(h.handlers, "before_agent_start", { systemPrompt: "child" }, ctx))[0]).toBeUndefined();
		expect((await emit(h.handlers, "context", { messages: [] }, ctx))[0]).toBeUndefined();
		await h.commands.get("btw")?.handler("merge continue", ctx);
		expect(store.request).toBeUndefined();
		expect(notifications.at(-1)?.message).toContain("Continue as an independent Pi session");
		await emit(h.handlers, "session_shutdown", { reason: "quit" }, ctx);
		expect(store.removed).toBe(0);
		expect(h.sentUserMessages).toEqual([]);
	});

	it("allows reload with the same first child session ID to replay parent context", async () => {
		const value = payload();
		const store = new FakeStore(value, {
			version: 1,
			launchId: value.launchId,
			paneId: "w1:p2",
			agentName: "btw-child",
			childSessionId: "first-child-session",
			status: "child_ready",
			updatedAt: value.createdAt,
		});
		const h = harness();
		await registerBtwChild(h.pi, {
			store,
			client: {
				async getAgent() { return { paneId: "w1:p2" }; },
				async focusAgent() {},
				async closePane() {},
			},
			payloadPath: "/private/payload.json",
			runtime: { inside: true, paneId: "w1:p2", socketPath: "/tmp/herdr" },
		});
		const { ctx } = context("first-child-session");
		await emit(h.handlers, "session_start", { reason: "reload" }, ctx);
		const promptResult = (await emit(h.handlers, "before_agent_start", { systemPrompt: "child" }, ctx))[0];
		expect(promptResult).toEqual({ systemPrompt: "parent system" });
		const contextResult = (await emit(h.handlers, "context", { messages: [] }, ctx))[0] as { messages: unknown[] };
		expect(contextResult.messages.length).toBeGreaterThan(1);
		expect(store.writes).toEqual([]);
	});
});
