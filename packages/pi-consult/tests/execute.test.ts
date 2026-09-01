import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { runConsultPanel, type CompleteSimpleFn } from "../src/execute.ts";
import type { ResolvedPanelMember } from "../src/panel.ts";

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

function member(id: string): ResolvedPanelMember {
	return {
		label: `anthropic/${id}`,
		effort: "high",
		model: { provider: "anthropic", id, name: id } as ResolvedPanelMember["model"],
	};
}

describe("runConsultPanel", () => {
	it("retries a single empty response then succeeds", async () => {
		let calls = 0;
		const completeSimple: CompleteSimpleFn = async () => {
			calls += 1;
			if (calls === 1) return response("");
			return response('{"verdict":"plan","summary":"next"}');
		};
		const [outcome] = await runConsultPanel({
			members: [member("one")],
			messages: [],
			completeSimple,
			useRuntimeFacade: true,
		});
		expect(calls).toBe(2);
		expect(outcome).toMatchObject({ ok: true, text: '{"verdict":"plan","summary":"next"}' });
	});

	it("does not retry aborted or error stops", async () => {
		let calls = 0;
		const completeSimple: CompleteSimpleFn = async () => {
			calls += 1;
			return response("", "aborted");
		};
		const [outcome] = await runConsultPanel({
			members: [member("one")],
			messages: [],
			completeSimple,
			useRuntimeFacade: true,
		});
		expect(calls).toBe(1);
		expect(outcome.ok).toBe(false);
	});

	it("fans out in parallel", async () => {
		const seen: string[] = [];
		const completeSimple: CompleteSimpleFn = async (model) => {
			seen.push(model.id);
			return response(`{"verdict":"plan","summary":"${model.id}"}`);
		};
		const outcomes = await runConsultPanel({
			members: [member("one"), member("two")],
			messages: [],
			completeSimple,
			useRuntimeFacade: true,
		});
		expect(seen.sort()).toEqual(["one", "two"]);
		expect(outcomes).toHaveLength(2);
		expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
	});
});
