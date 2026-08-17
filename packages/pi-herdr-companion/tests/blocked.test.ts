import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { cloneCompanionConfig, type CompanionConfig } from "../src/config.ts";
import { registerBlockedAdapters } from "../src/blocked/adapter.ts";
import {
	BlockedDepthTracker,
	HERDR_BLOCKED_EVENT,
} from "../src/blocked/tracker.ts";

function config(): CompanionConfig {
	return cloneCompanionConfig();
}

describe("BlockedDepthTracker", () => {
	it("balances nested true/false and ignores unknown false", () => {
		const signals: unknown[] = [];
		const tracker = new BlockedDepthTracker("question", (signal) => signals.push(signal));
		tracker.update(false);
		tracker.update(true);
		tracker.update(true);
		tracker.update(false);
		expect(tracker.activeDepth).toBe(1);
		tracker.clear();
		expect(tracker.activeDepth).toBe(0);
		expect(signals).toEqual([
			{ active: true, label: "question" },
			{ active: true, label: "question" },
			{ active: false },
			{ active: false },
		]);
	});
});

describe("generic blocked adapters", () => {
	function harness(runtimeInside = true) {
		const eventListeners = new Map<string, Set<(data: unknown) => void>>();
		const lifecycle = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const pi = {
			events: {
				on(name: string, listener: (data: unknown) => void) {
					const listeners = eventListeners.get(name) ?? new Set();
					listeners.add(listener);
					eventListeners.set(name, listeners);
					return () => listeners.delete(listener);
				},
				emit(name: string, data: unknown) {
					for (const listener of [...(eventListeners.get(name) ?? [])]) listener(data);
				},
			},
			on(name: string, listener: (event: unknown, ctx: unknown) => unknown) {
				const listeners = lifecycle.get(name) ?? [];
				listeners.push(listener as never);
				lifecycle.set(name, listeners);
			},
		} as unknown as ExtensionAPI;
		const cfg = config();
		const controller = registerBlockedAdapters(pi, {
			inside: runtimeInside,
			paneId: runtimeInside ? "w1:p1" : undefined,
			socketPath: runtimeInside ? "/tmp/herdr" : undefined,
		}, () => cfg);
		const ctx = { mode: "tui", isIdle: () => true };
		return {
			pi,
			cfg,
			controller,
			emit: (name: string, data: unknown) => pi.events.emit(name, data),
			async lifecycle(name: string, event: unknown = {}, override: unknown = ctx) {
				for (const listener of lifecycle.get(name) ?? []) await listener(event, override);
			},
		};
	}

	it("tracks configured tools by call ID and force-clears unfinished calls", async () => {
		const h = harness();
		const signals: unknown[] = [];
		h.pi.events.on(HERDR_BLOCKED_EVENT, (data) => signals.push(data));
		await h.lifecycle("session_start");
		await h.lifecycle("tool_execution_start", { toolCallId: "a", toolName: "ask_user_question" });
		await h.lifecycle("tool_execution_start", { toolCallId: "b", toolName: "ask_user_question" });
		await h.lifecycle("tool_execution_start", { toolCallId: "x", toolName: "read" });
		await h.lifecycle("tool_execution_end", { toolCallId: "a", toolName: "ask_user_question" });
		await h.lifecycle("tool_execution_end", { toolCallId: "unknown", toolName: "ask_user_question" });
		await h.lifecycle("agent_settled");
		expect(signals).toEqual([
			{ active: true, label: "question" },
			{ active: true, label: "question" },
			{ active: false },
			{ active: false },
		]);
	});

	it("preserves unchanged in-flight tools and events across unrelated config saves", async () => {
		const h = harness();
		h.cfg.blocked.events = [{ name: "custom:blocked", label: "review" }];
		const signals: unknown[] = [];
		h.pi.events.on(HERDR_BLOCKED_EVENT, (data) => signals.push(data));
		await h.lifecycle("session_start");
		await h.lifecycle("tool_execution_start", { toolCallId: "a", toolName: "ask_user_question" });
		h.emit("custom:blocked", { active: true });

		h.cfg.runtime.injectSystemPrompt = !h.cfg.runtime.injectSystemPrompt;
		h.controller.sync();
		expect(signals).toEqual([
			{ active: true, label: "question" },
			{ active: true, label: "review" },
		]);

		await h.lifecycle("tool_execution_end", { toolCallId: "a", toolName: "ask_user_question" });
		h.emit("custom:blocked", { active: false });
		expect(signals).toEqual([
			{ active: true, label: "question" },
			{ active: true, label: "review" },
			{ active: false },
			{ active: false },
		]);
	});

	it("ignores duplicate initialization of the same session context", async () => {
		const h = harness();
		const signals: unknown[] = [];
		h.pi.events.on(HERDR_BLOCKED_EVENT, (data) => signals.push(data));
		await h.lifecycle("session_start");
		await h.lifecycle("tool_execution_start", { toolCallId: "a", toolName: "ask_user_question" });
		await h.lifecycle("session_start");
		expect(signals).toEqual([{ active: true, label: "question" }]);
		await h.lifecycle("tool_execution_end", { toolCallId: "a", toolName: "ask_user_question" });
		expect(signals).toEqual([
			{ active: true, label: "question" },
			{ active: false },
		]);
	});

	it("relabels active calls without losing their call IDs or blocked depth", async () => {
		const h = harness();
		const signals: unknown[] = [];
		h.pi.events.on(HERDR_BLOCKED_EVENT, (data) => signals.push(data));
		await h.lifecycle("session_start");
		await h.lifecycle("tool_execution_start", { toolCallId: "a", toolName: "ask_user_question" });
		h.cfg.blocked.tools = [{ name: "ask_user_question", label: "approval" }];
		h.controller.sync();
		await h.lifecycle("tool_execution_end", { toolCallId: "a", toolName: "ask_user_question" });
		expect(signals).toEqual([
			{ active: true, label: "question" },
			{ active: false },
			{ active: true, label: "approval" },
			{ active: false },
		]);
	});

	it("adapts arbitrary counted events and hot-swaps subscriptions safely", async () => {
		const h = harness();
		h.cfg.blocked.tools = [];
		h.cfg.blocked.events = [{ name: "custom:blocked", label: "review" }];
		const signals: unknown[] = [];
		h.pi.events.on(HERDR_BLOCKED_EVENT, (data) => signals.push(data));
		await h.lifecycle("session_start");
		h.emit("custom:blocked", { active: true });
		h.emit("custom:blocked", { active: true });
		h.emit("custom:blocked", { active: "yes" });
		h.cfg.blocked.events = [{ name: "other:blocked", label: "approval" }];
		h.controller.sync();
		h.emit("custom:blocked", { active: true });
		h.emit("other:blocked", { active: true });
		h.emit("other:blocked", { active: false });
		expect(signals).toEqual([
			{ active: true, label: "review" },
			{ active: true, label: "review" },
			{ active: false },
			{ active: false },
			{ active: true, label: "approval" },
			{ active: false },
		]);
	});

	it("ignores outside Herdr but reports blocked state in non-TUI Herdr modes", async () => {
		const outside = harness(false);
		const outsideSignals: unknown[] = [];
		outside.pi.events.on(HERDR_BLOCKED_EVENT, (data) => outsideSignals.push(data));
		await outside.lifecycle("session_start", {}, { mode: "tui", isIdle: () => true });
		await outside.lifecycle("tool_execution_start", { toolCallId: "outside", toolName: "ask_user_question" });
		expect(outsideSignals).toEqual([]);

		const rpc = harness(true);
		const rpcSignals: unknown[] = [];
		rpc.pi.events.on(HERDR_BLOCKED_EVENT, (data) => rpcSignals.push(data));
		await rpc.lifecycle("session_start", {}, { mode: "rpc", isIdle: () => true });
		await rpc.lifecycle("tool_execution_start", { toolCallId: "rpc", toolName: "ask_user_question" });
		await rpc.lifecycle("tool_execution_end", { toolCallId: "rpc", toolName: "ask_user_question" });
		expect(rpcSignals).toEqual([
			{ active: true, label: "question" },
			{ active: false },
		]);
	});

	it("never lets a failing Herdr listener break a configured source", async () => {
		const h = harness();
		h.pi.events.on(HERDR_BLOCKED_EVENT, () => { throw new Error("reporter failed"); });
		await h.lifecycle("session_start");
		await expect(h.lifecycle("tool_execution_start", { toolCallId: "a", toolName: "ask_user_question" }))
			.resolves.toBeUndefined();
		await expect(h.lifecycle("tool_execution_end", { toolCallId: "a", toolName: "ask_user_question" }))
			.resolves.toBeUndefined();
	});
});
