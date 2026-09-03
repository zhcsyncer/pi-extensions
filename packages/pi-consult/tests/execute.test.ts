import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executeConsult, runConsultPanel, type CompleteSimpleFn } from "../src/execute.ts";
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

describe("executeConsult budget reservation", () => {
	it("allows only one parallel paid request at the per-run cap", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "pi-consult-execute-"));
		try {
			const advisor = member("one").model;
			const tracker = new ConsultTracker();
			const config: ConsultConfig = {
				panel: [{ model: "anthropic/one", effort: "high" }],
				fanout: false,
				gates: { loop: 3 },
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
			const completeSimple: CompleteSimpleFn = async () => {
				paidCalls += 1;
				return response('{"verdict":"plan","summary":"continue"}');
			};
			const call = () => executeConsult({
				why: "two approaches change the structure",
				ctx,
				pi,
				config,
				tracker,
				agentDir: directory,
				completeSimple,
			});

			const results = await Promise.all([call(), call()]);
			expect(paidCalls).toBe(1);
			expect(authCalls).toBe(2);
			expect(tracker.runCount).toBe(1);
			const completed = results.find((result) => result.details?.envelope?.summary === "continue");
			const blocked = results.find((result) => result.details?.envelope?.error === ERR_BUDGET_RUN);
			expect(completed?.details?.outcome).toBe("completed");
			expect(blocked?.details?.outcome).toBe("blocked");
			expect(blocked?.content[0]?.type === "text" && blocked.content[0].text).not.toContain("CONSULT-LOG:");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

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
