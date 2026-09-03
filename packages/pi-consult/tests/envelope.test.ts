import { describe, expect, it } from "vitest";
import {
	buildConsultEnvelope,
	buildConsultToolResult,
	errorEnvelope,
	mergeAdvisorOutcomes,
	parseAdvisorText,
	sumUsage,
	usageSnapshotFrom,
} from "../src/envelope.ts";

describe("consult envelope", () => {
	it("parses JSON verdicts and falls back to plan", () => {
		expect(parseAdvisorText('{"verdict":"correction","summary":"Stop editing that file"}')).toEqual({
			verdict: "correction",
			summary: "Stop editing that file",
		});
		expect(parseAdvisorText("```json\n{\"verdict\":\"stop\",\"summary\":\"Ask the user\"}\n```")).toEqual({
			verdict: "stop",
			summary: "Ask the user",
		});
		expect(parseAdvisorText("Just try grep.")).toEqual({ verdict: "plan", summary: "Just try grep." });
	});

	it("merges matching verdicts and splits on conflict", () => {
		const merged = mergeAdvisorOutcomes([
			{ ok: true, label: "a", text: '{"verdict":"plan","summary":"Do X"}' },
			{ ok: true, label: "b", text: '{"verdict":"plan","summary":"Do X then Y"}' },
		]);
		expect(merged.verdict).toBe("plan");
		expect(merged.summary).toContain("Do X");

		const split = mergeAdvisorOutcomes([
			{ ok: true, label: "a", text: '{"verdict":"plan","summary":"Keep going"}' },
			{ ok: true, label: "b", text: '{"verdict":"stop","summary":"Escalate"}' },
		]);
		expect(split.verdict).toBe("split");
		expect(split.conflicts).toHaveLength(2);
	});

	it("uses successful paths when the other side fails", () => {
		const envelope = mergeAdvisorOutcomes([
			{ ok: false, label: "a", error: "no key" },
			{ ok: true, label: "b", text: '{"verdict":"correction","summary":"Turn around"}' },
		]);
		expect(envelope.verdict).toBe("correction");
		expect(envelope.error).toBeUndefined();
	});

	it("builds a single error envelope when every path fails", () => {
		const envelope = mergeAdvisorOutcomes([
			{ ok: false, label: "a", error: "timeout" },
			{ ok: false, label: "b", error: "aborted" },
		]);
		expect(envelope.error).toMatch(/timeout/);
		expect(envelope.verdict).toBe("plan");
	});

	it("marks blocked results without asking for a CONSULT-LOG or recording phantom usage", () => {
		const envelope = errorEnvelope("Consult run budget exhausted.");
		const result = buildConsultToolResult({ envelope, trigger: "pull", models: [], outcome: "blocked" });
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(result.content[0]?.type === "text" && result.content[0].text).not.toContain("CONSULT-LOG:");
		expect(result.details?.outcome).toBe("blocked");
		expect(result.details?.envelope).toEqual(envelope);
		expect(result.details?.errorMessage).toBe(envelope.error);
		expect(result.usage).toBeUndefined();
	});

	it("normalizes provider cache and cost usage", () => {
		expect(
			usageSnapshotFrom({
				input: 10,
				output: 2,
				cacheRead: 100,
				cacheWrite: 4,
				totalTokens: 116,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.04, total: 0.35 },
			}),
		).toEqual({
			input: 10,
			output: 2,
			cacheRead: 100,
			cacheWrite: 4,
			totalTokens: 116,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.04, total: 0.35 },
		});
	});

	it("asks for a CONSULT-LOG only after completed advice", () => {
		const envelope = buildConsultEnvelope({ verdict: "plan", summary: "continue", raw: [] });
		const result = buildConsultToolResult({ envelope, trigger: "pull", models: ["advisor"] });
		expect(result.content[0]?.type === "text" && result.content[0].text).toContain("CONSULT-LOG:");
		expect(result.details?.outcome).toBe("completed");
	});

	it("sums input, cache, output, and cost across raw paths", () => {
		const envelope = buildConsultEnvelope({
			verdict: "plan",
			summary: "ok",
			raw: [
				{
					model: "a",
					text: "x",
					usage: {
						input: 10,
						output: 2,
						cacheRead: 100,
						cacheWrite: 3,
						totalTokens: 115,
						cost: { input: 0.1, output: 0.1, cacheRead: 0.01, cacheWrite: 0.03, total: 0.24 },
					},
				},
				{
					model: "b",
					text: "y",
					usage: {
						input: 5,
						output: 1,
						cacheRead: 50,
						cacheWrite: 0,
						totalTokens: 56,
						cost: { input: 0.05, output: 0.05, cacheRead: 0.01, cacheWrite: 0, total: 0.11 },
					},
				},
			],
		});
		const usage = sumUsage(envelope.raw);
		expect(usage).toMatchObject({
			input: 15,
			output: 3,
			cacheRead: 150,
			cacheWrite: 3,
			totalTokens: 171,
		});
		expect(usage?.cost.input).toBeCloseTo(0.15);
		expect(usage?.cost.output).toBeCloseTo(0.15);
		expect(usage?.cost.cacheRead).toBeCloseTo(0.02);
		expect(usage?.cost.cacheWrite).toBeCloseTo(0.03);
		expect(usage?.cost.total).toBeCloseTo(0.35);
		const result = buildConsultToolResult({ envelope, trigger: "pull", models: ["a", "b"], usage });
		expect(result.usage).toEqual(usage);
	});
});
