import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { estimateOutputTokens, executeConsult, runConsultPanel, type StreamSimpleFn } from "../src/execute.ts";
import { readRecentEvents } from "../src/events.ts";
import { ERR_BUDGET_RUN } from "../src/messages.ts";
import type { ResolvedPanelMember } from "../src/panel.ts";
import { ConsultTracker } from "../src/tracker.ts";
import type { ConsultConfig } from "../src/types.ts";

function usage() {
	return {
		input: 11,
		output: 3,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 14,
		cost: { input: 0.1, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.11 },
	};
}

function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function response(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-fable-5",
		usage: usage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function responseStream(message: AssistantMessage, deltas: { thinking?: string; text?: string } = {}) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const partial: AssistantMessage = { ...message, content: [], usage: emptyUsage() };
		stream.push({ type: "start", partial });
		if (deltas.thinking !== undefined) {
			stream.push({ type: "thinking_start", contentIndex: 0, partial });
			stream.push({ type: "thinking_delta", contentIndex: 0, delta: deltas.thinking, partial });
			stream.push({ type: "thinking_end", contentIndex: 0, content: deltas.thinking, partial });
		}
		if (deltas.text !== undefined) {
			stream.push({ type: "text_start", contentIndex: 1, partial });
			stream.push({ type: "text_delta", contentIndex: 1, delta: deltas.text, partial });
			stream.push({ type: "text_end", contentIndex: 1, content: deltas.text, partial });
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			stream.push({ type: "error", reason: message.stopReason, error: message });
		} else {
			const reason = message.stopReason === "length" || message.stopReason === "toolUse" || message.stopReason === "deferred"
				? message.stopReason
				: "stop";
			stream.push({ type: "done", reason, message });
		}
	});
	return stream;
}

function member(id: string): ResolvedPanelMember {
	return {
		label: `anthropic/${id}`,
		effort: "high",
		model: { provider: "anthropic", id, name: id } as ResolvedPanelMember["model"],
	};
}

describe("executeConsult budget reservation", () => {
	it("allows only one parallel paid request at the per-run cap", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "pi-consult-execute-"));
		try {
			const advisor = member("one").model;
			const tracker = new ConsultTracker();
			const config: ConsultConfig = {
				panel: [{ model: "anthropic/one", effort: "high" }],
				fanout: false,
				gates: { watchdog: 3 },
				budget: { perRun: 1, perSession: 8 },
				disabledForModels: [],
			};
			let authCalls = 0;
			const ctx = {
				modelRegistry: {
					find: () => advisor,
					getApiKeyAndHeaders: async () => {
						authCalls += 1;
						return { ok: true, apiKey: "test" };
					},
				},
				sessionManager: {
					getEntries: () => [],
					getLeafId: () => null,
					getSessionFile: () => null,
				},
			} as unknown as ExtensionContext;
			const pi = { getAllTools: () => [] } as unknown as ExtensionAPI;
			let paidCalls = 0;
			const streamSimple: StreamSimpleFn = () => {
				paidCalls += 1;
				return responseStream(response('{"verdict":"confirm","summary":"continue"}'));
			};
			let toolCallSequence = 0;
			const call = () => executeConsult({
				why: "two approaches change the structure",
				toolCallId: `consult-${++toolCallSequence}`,
				ctx,
				pi,
				config,
				tracker,
				agentDir: directory,
				streamSimple,
				onUpdate: () => {
					throw new Error("render failed");
				},
			});

			const results = await Promise.all([call(), call()]);
			expect(paidCalls).toBe(1);
			expect(authCalls).toBe(2);
			expect(tracker.runCount).toBe(1);
			const completed = results.find((result) => result.details?.envelope?.summary === "continue");
			const blocked = results.find((result) => result.details?.envelope?.error === ERR_BUDGET_RUN);
			expect(completed?.details?.outcome).toBe("completed");
			expect(completed?.usage).toEqual(usage());
			expect(blocked?.details?.outcome).toBe("blocked");
			expect(blocked?.usage).toBeUndefined();
			expect(blocked?.content[0]?.type === "text" && blocked.content[0].text).not.toContain("CONSULT-LOG:");
			const events = await readRecentEvents(10, directory);
			expect(events).toHaveLength(2);
			expect(events.map((event) => event.toolCallId).sort()).toEqual(["consult-1", "consult-2"]);
			expect(events.map((event) => event.outcome).sort()).toEqual(["blocked", "completed"]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("runConsultPanel", () => {
	it("streams connecting, thinking, and writing progress with an output estimate", async () => {
		const progress: Array<{ phase: string; approxOutputTokens: number }> = [];
		const finalText = '{"verdict":"confirm","summary":"继续验证"}';
		const [outcome] = await runConsultPanel({
			members: [member("one")],
			messages: [],
			streamSimple: () => responseStream(response(finalText), { thinking: "先分析证据", text: finalText }),
			useRuntimeFacade: true,
			onProgress: (_label, update) => progress.push(update),
		});
		expect(outcome?.ok).toBe(true);
		expect(progress.map((item) => item.phase)).toEqual(expect.arrayContaining(["connecting", "thinking", "writing"]));
		expect(progress.filter((item) => item.phase === "writing").at(-1)?.approxOutputTokens).toBeGreaterThan(0);
		expect(estimateOutputTokens("abcd中文")).toBe(3);
	});

	it("retries a single empty response, preserves live progress, and sums exact usage", async () => {
		let calls = 0;
		const progress: Array<{ phase: string; approxOutputTokens: number; attempt: number }> = [];
		const streamSimple: StreamSimpleFn = () => {
			calls += 1;
			return responseStream(calls === 1 ? response("") : response('{"verdict":"recommend","summary":"next"}'));
		};
		const [outcome] = await runConsultPanel({
			members: [member("one")],
			messages: [],
			streamSimple,
			useRuntimeFacade: true,
			onProgress: (_label, update) => progress.push(update),
		});
		expect(calls).toBe(2);
		expect(progress).toContainEqual({ phase: "connecting", approxOutputTokens: 3, attempt: 2 });
		expect(outcome).toMatchObject({
			ok: true,
			text: '{"verdict":"recommend","summary":"next"}',
			effort: "high",
			attempts: 2,
			durationMs: expect.any(Number),
			usage: {
				input: 22,
				output: 6,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 28,
				cost: { input: 0.2, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.22 },
			},
		});
	});

	it("does not retry aborted or error stops", async () => {
		let calls = 0;
		const streamSimple: StreamSimpleFn = () => {
			calls += 1;
			return responseStream(response("", "aborted"));
		};
		const [outcome] = await runConsultPanel({
			members: [member("one")],
			messages: [],
			streamSimple,
			useRuntimeFacade: true,
		});
		expect(calls).toBe(1);
		expect(outcome?.ok).toBe(false);
	});

	it("fans out in parallel", async () => {
		const seen: string[] = [];
		const streamSimple: StreamSimpleFn = (model) => {
			seen.push(model.id);
			return responseStream(response(`{"verdict":"recommend","summary":"${model.id}"}`));
		};
		const outcomes = await runConsultPanel({
			members: [member("one"), member("two")],
			messages: [],
			streamSimple,
			useRuntimeFacade: true,
		});
		expect(seen.sort()).toEqual(["one", "two"]);
		expect(outcomes).toHaveLength(2);
		expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
	});
});
