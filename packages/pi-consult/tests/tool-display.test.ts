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

const correctionResult = {
	details: {
		trigger: "pull" as const,
		models: ["cursor/fable-5.1"],
		effort: "xhigh",
		envelope: { verdict: "correction" as const, summary: "Stop editing parser.ts", raw: [] },
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

	it("collapses the result to verdict · summary without repeating why", () => {
		expect(consultResultLines(correctionResult, { expanded: false }, theme)).toEqual([
			"correction · Stop editing parser.ts",
		]);
	});

	it("removes Markdown chrome without damaging protected technical syntax", () => {
		const summary =
			"**先停止**编辑 `__dirname__`。\n```c\n#define RETRY_FLAG 1\n```\n- 运行 [相关测试](https://example.test)\n- ~~删除~~旧分支";
		expect(markdownPreview(summary)).toBe(
			"先停止编辑 __dirname__。 #define RETRY_FLAG 1 运行 相关测试 删除旧分支",
		);
		expect(
			consultResultLines(
				{ details: { ...correctionResult.details, envelope: { verdict: "correction", summary, raw: [] } } },
				{ expanded: false },
				theme,
			),
		).toEqual(["correction · 先停止编辑 __dirname__。 #define RETRY_FLAG 1 运行 相关测试 删除旧分支"]);
	});

	it("expands summary and models, not why", () => {
		const lines = consultResultLines(
			{
				details: {
					trigger: "loop",
					models: ["cursor/fable-5.1"],
					envelope: {
						verdict: "split",
						summary: "Advisors disagree",
						conflicts: ["a: plan — keep going"],
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
		expect(lines).toContain("a: plan — keep going");
		expect(lines).toContain("cursor/fable-5.1");
		expect(lines).not.toContain("same bash failed twice");
	});

	it("renders waiting as consulting, not a fake plan verdict", () => {
		expect(
			consultResultLines(
				{ details: { trigger: "pull", models: ["cursor/fable-5.1"], effort: "xhigh" } },
				{ expanded: false, isPartial: true },
				theme,
				{ isPartial: true },
				12_000,
			),
		).toEqual(["consulting cursor/fable-5.1 · xhigh  12s"]);
	});

	it("renders a budget refusal as blocked rather than failed", () => {
		const component = renderConsultResult(
			{
				details: {
					trigger: "pull",
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
					trigger: "pull",
					models: ["cursor/fable-5.1"],
					envelope: {
						verdict: "plan",
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
			correctionResult,
			{ expanded: false, isPartial: false },
			theme,
			{ adoption: { adopted: true, reason: "matches the primary evidence" } },
		);
		const rows = component.render(80);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("correction · Stop editing parser.ts");
		expect(rows[1]).toContain("adopt · matches the primary evidence");
		expect(rows[1]).toMatch(/Ctrl\+O to expand\)$/);
	});

	it("wraps the full adoption reason before the model when expanded", () => {
		const lines = consultResultLines(correctionResult, { expanded: true }, theme, {
			adoption: {
				adopted: false,
				reason: "the primary-source evidence points in the opposite direction",
			},
		});
		expect(lines).toEqual([
			"correction",
			"Stop editing parser.ts",
			"reject · the primary-source evidence points in the opposite direction",
			"cursor/fable-5.1",
		]);
	});

	it("distinguishes failed and cancelled results without adoption", () => {
		const failed = consultResultLines(
			{ details: { models: [], outcome: "failed", envelope: errorEnvelope("Provider failed") } },
			{ expanded: true },
			theme,
			{ adoption: { adopted: true, reason: "irrelevant" } },
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
