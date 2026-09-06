import { afterEach, describe, expect, it, vi } from "vitest";
import {
	consultResultLines,
	formatConsultCallLine,
	markdownPreview,
	formatElapsed,
	renderConsultCall,
	renderConsultResult,
	tickElapsed,
} from "../src/tool-display.ts";
import { errorEnvelope } from "../src/envelope.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const reviseResult = {
	details: {
		trigger: "onDemand" as const,
		models: ["cursor/fable-5.1"],
		envelope: {
			verdict: "revise" as const,
			summary: "Stop editing parser.ts",
			raw: [
				{
					model: "cursor/fable-5.1",
					effort: "xhigh" as const,
					text: "result",
					usage: {
						input: 320_000,
						output: 1_100,
						cacheRead: 2_000,
						cacheWrite: 0,
						totalTokens: 323_100,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					durationMs: 28_000,
					attempts: 1,
				},
			],
		},
	},
};

afterEach(() => {
	vi.useRealTimers();
});

describe("consult Claude-style rows", () => {
	it("formats the call as ● Consult(why)", () => {
		expect(formatConsultCallLine({ why: "two approaches lock the layout" }, theme)).toBe(
			"● Consult(two approaches lock the layout)",
		);
		expect(formatConsultCallLine({ why: "x" }, theme, { isError: true })).toBe("● Consult(x)");
	});

	it("collapses to summary plus one execution metadata line", () => {
		expect(consultResultLines(reviseResult, { expanded: false }, theme)).toEqual([
			"revise · Stop editing parser.ts",
			"on-demand · cursor/fable-5.1:xhigh · in 322k · out 1.1k · total 323k · 28s",
		]);
	});

	it("keeps each fanout advisor on one self-contained metadata line", () => {
		const raw = reviseResult.details.envelope.raw[0];
		const lines = consultResultLines(
			{
				details: {
					...reviseResult.details,
					envelope: {
						verdict: "confirm",
						summary: "Both advisors agree.",
						raw: [
							{ ...raw, model: "cursor/fable-5.1", effort: "high" as const, durationMs: 10_000 },
							{ ...raw, model: "cursor/opus-5", effort: "xhigh" as const, durationMs: 20_000 },
						],
					},
				},
			},
			{ expanded: false },
			theme,
		);
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("on-demand · cursor/fable-5.1:high");
		expect(lines[1]).toMatch(/ · 10s$/);
		expect(lines[2]).toContain("on-demand · cursor/opus-5:xhigh");
		expect(lines[2]).toMatch(/ · 20s$/);
	});

	it("removes Markdown chrome without damaging protected technical syntax", () => {
		const summary =
			"**先停止**编辑 `__dirname__`。\n```c\n#define RETRY_FLAG 1\n```\n- 运行 [相关测试](https://example.test)\n- ~~删除~~旧分支";
		expect(markdownPreview(summary)).toBe(
			"先停止编辑 __dirname__。 #define RETRY_FLAG 1 运行 相关测试 删除旧分支",
		);
		expect(
			consultResultLines(
				{ details: { ...reviseResult.details, envelope: { verdict: "revise", summary, raw: [] } } },
				{ expanded: false },
				theme,
			),
		).toEqual([
			"revise · 先停止编辑 __dirname__。 #define RETRY_FLAG 1 运行 相关测试 删除旧分支",
			"on-demand · cursor/fable-5.1",
		]);
	});

	it("expands summary and models, not why", () => {
		const lines = consultResultLines(
			{
				details: {
					trigger: "watchdog",
					models: ["cursor/fable-5.1"],
					envelope: {
						verdict: "split",
						summary: "Advisors disagree",
						conflicts: ["a: confirm — keep going"],
						raw: [],
					},
				},
			},
			{ expanded: true },
			theme,
			{ args: { why: "same bash failed twice" } },
		);
		expect(lines[0]).toBe("split");
		expect(lines).toContain("Advisors disagree");
		expect(lines).toContain("a: confirm — keep going");
		expect(lines).toContain("watchdog · cursor/fable-5.1");
		expect(lines).not.toContain("same bash failed twice");
	});

	it("renders live advisor phase and approximate output while waiting", () => {
		expect(
			consultResultLines(
				{
					details: {
						trigger: "onDemand",
						models: ["cursor/fable-5.1"],
						live: [{ model: "cursor/fable-5.1", effort: "xhigh", phase: "thinking", approxOutputTokens: 1_234 }],
					},
				},
				{ expanded: false, isPartial: true },
				theme,
				{ isPartial: true },
				12_000,
			),
		).toEqual(["consulting · on-demand · cursor/fable-5.1:xhigh · thinking · ~1.2k out  12s"]);
	});

	it("renders a budget refusal as blocked rather than failed", () => {
		const component = renderConsultResult(
			{
				details: {
					trigger: "onDemand",
					models: [],
					outcome: "blocked",
					envelope: errorEnvelope("Consult run budget exhausted; resets on next user message."),
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			{ args: { why: "x" } },
		);
		const line = component.render(100)[0] ?? "";
		expect(line).toMatch(/^ {2}⎿ /);
		expect(line).toContain("blocked · Consult run budget exhausted; resets on next user message.");
		expect(line).not.toContain("failed");
		expect(line).toMatch(/Ctrl\+O to expand\)$/);
	});

	it("wraps expanded why and summary instead of truncating them", () => {
		const why =
			"需要决定 infra-edge 最小内部监控实现，以及下一步先做现有数据可视化还是新增采集。候选包括容器化 Alloy。";
		const call = renderConsultCall({ why }, theme, { expanded: true });
		expect(call.render(40).length).toBeGreaterThan(1);
		expect(call.render(40).every((line) => !line.includes("…"))).toBe(true);

		const result = renderConsultResult(
			{
				details: {
					trigger: "onDemand",
					models: ["cursor/fable-5.1"],
					envelope: {
						verdict: "recommend",
						summary:
							"推荐：infra-edge 用一个容器化 Alloy，不用 node_exporter+vmagent 第二套工具链，不用纯健康脚本。",
						raw: [],
					},
				},
			},
			{ expanded: true, isPartial: false },
			theme,
			{ args: { why } },
		);
		const rows = result.render(42);
		expect(rows[0]?.startsWith("  ⎿ ")).toBe(true);
		expect(rows.some((line) => line.startsWith("    "))).toBe(true);
		expect(rows.join("\n")).toContain("容器化 Alloy");
		expect(rows.join("\n")).not.toContain(why);
	});

	it("mirrors adoption under the collapsed Consult result", () => {
		const component = renderConsultResult(
			reviseResult,
			{ expanded: false, isPartial: false },
			theme,
			{ adoption: { adopted: true, effect: "changed", reason: "matches the primary evidence" } },
		);
		const rows = component.render(80);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toContain("revise · Stop editing parser.ts");
		expect(rows[1]).toContain("on-demand · cursor/fable-5.1:xhigh");
		expect(rows[2]).toContain("adopt · matches the primary evidence");
		expect(rows[2]).toMatch(/Ctrl\+O to expand\)$/);
	});

	it("wraps the full adoption reason before the model when expanded", () => {
		const lines = consultResultLines(reviseResult, { expanded: true }, theme, {
			adoption: {
				adopted: false,
				effect: "rejected",
				reason: "the primary-source evidence points in the opposite direction",
			},
		});
		expect(lines).toEqual([
			"revise",
			"Stop editing parser.ts",
			"reject · the primary-source evidence points in the opposite direction",
			"on-demand · cursor/fable-5.1:xhigh · in 322k · out 1.1k · total 323k · 28s",
		]);
	});

	it("distinguishes failed and cancelled results without adoption", () => {
		const failed = consultResultLines(
			{ details: { models: [], outcome: "failed", envelope: errorEnvelope("Provider failed") } },
			{ expanded: true },
			theme,
			{ adoption: { adopted: true, effect: "confirmed", reason: "irrelevant" } },
		);
		expect(failed).toEqual(["failed", "Provider failed"]);

		const cancelled = consultResultLines(
			{ details: { models: [], outcome: "cancelled", envelope: errorEnvelope("Request cancelled") } },
			{ expanded: true },
			theme,
		);
		expect(cancelled).toEqual(["cancelled", "Request cancelled"]);
	});

	it("truncates collapsed why to one line", () => {
		const why = "need to choose the smallest infra-edge monitoring implementation and whether to visualize first";
		const rows = renderConsultCall({ why }, theme, { expanded: false }).render(40);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.includes("…")).toBe(true);
	});
});

describe("consult elapsed waiting", () => {
	it("formats seconds then minutes", () => {
		expect(formatElapsed(0)).toBe("0s");
		expect(formatElapsed(12_000)).toBe("12s");
		expect(formatElapsed(65_000)).toBe("1m 05s");
	});

	it("ticks elapsed while partial and clears the timer when done", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-02T00:00:00.000Z"));
		const state: Record<string, unknown> = {};
		const invalidate = vi.fn();
		expect(tickElapsed({ state, invalidate }, true)).toBe(0);
		vi.advanceTimersByTime(1000);
		expect(invalidate).toHaveBeenCalled();
		vi.setSystemTime(new Date("2026-09-02T00:00:12.000Z"));
		expect(tickElapsed({ state, invalidate }, true)).toBe(12_000);
		tickElapsed({ state, invalidate }, false);
		invalidate.mockClear();
		vi.advanceTimersByTime(1000);
		expect(invalidate).not.toHaveBeenCalled();
	});
});
