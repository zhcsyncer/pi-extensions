import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { renderConsultResult } from "../src/tool-display.ts";

beforeAll(() => {
	initTheme("dark", false);
});

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const markdownResult = {
	details: {
		trigger: "onDemand" as const,
		models: ["cursor/fable-5.1"],
		envelope: {
			verdict: "recommend" as const,
			summary: "**先运行** `pnpm test`：\n\n- 检查失败原因\n- 保留必要改动",
			raw: [],
		},
	},
};

function stripSgr(value: string): string {
	return value.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("consult expanded Markdown", () => {
	it("renders the summary as Markdown only when expanded", () => {
		const expanded = renderConsultResult(markdownResult, { expanded: true, isPartial: false }, theme, {});
		const expandedRows = expanded.render(38);
		const expandedOutput = stripSgr(expandedRows.join("\n"));
		expect(expandedOutput).toContain("先运行");
		expect(expandedOutput).toContain("pnpm test");
		expect(expandedOutput).toContain("检查失败原因");
		expect(expandedOutput).not.toContain("**");
		expect(expandedOutput).not.toContain("`");

		const collapsed = renderConsultResult(markdownResult, { expanded: false, isPartial: false }, theme, {});
		const collapsedOutput = stripSgr(collapsed.render(160).join("\n"));
		expect(collapsedOutput).toContain("recommend · 先运行 pnpm test： 检查失败原因 保留必要改动");
		expect(collapsedOutput).not.toContain("**");
		expect(collapsedOutput).not.toContain("`");

		const partial = renderConsultResult(
			markdownResult,
			{ expanded: true, isPartial: true },
			theme,
			{ isPartial: true },
		);
		const partialOutput = stripSgr(partial.render(80).join("\n"));
		expect(partialOutput).toContain("consulting · on-demand · cursor/fable-5.1");
		expect(partialOutput).not.toContain("先运行");
	});

	it("shows only exact input, output, and total tokens after completion", () => {
		const result = renderConsultResult(
			{
				details: {
					trigger: "onDemand",
					models: ["cursor/fable-5.1"],
					envelope: {
						verdict: "confirm",
						summary: "继续验证。",
						raw: [{
							model: "cursor/fable-5.1",
							effort: "xhigh",
							text: "result",
							usage: {
								input: 11,
								output: 3,
								cacheRead: 100,
								cacheWrite: 20,
								totalTokens: 134,
								cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
							},
							durationMs: 28_000,
							attempts: 1,
						}],
					},
				},
			},
			{ expanded: true, isPartial: false },
			theme,
			{},
		);
		const output = stripSgr(result.render(100).join("\n"));
		expect(output).toContain("on-demand · cursor/fable-5.1:xhigh");
		expect(output).toContain("in 131 · out 3 · total 134");
		expect(output).not.toContain("cache");
		expect(output).not.toContain("$");
	});

	it("keeps every result branch within extremely narrow widths", () => {
		const components = [
			renderConsultResult(markdownResult, { expanded: true, isPartial: false }, theme, {
				adoption: { adopted: true, effect: "confirmed", reason: "matches current evidence" },
			}),
			renderConsultResult(markdownResult, { expanded: false, isPartial: false }, theme, {
				adoption: { adopted: false, effect: "rejected", reason: "evidence changed" },
			}),
			renderConsultResult(markdownResult, { expanded: true, isPartial: true }, theme, { isPartial: true }),
			renderConsultResult(
				{
					details: {
						models: ["cursor/fable-5.1"],
						outcome: "failed" as const,
						envelope: {
							verdict: "recommend" as const,
							summary: "",
							error: "Provider returned a long failure message",
							raw: [],
						},
					},
				},
				{ expanded: true, isPartial: false },
				theme,
				{},
			),
		];
		for (const width of [1, 2, 3, 4, 8, 12]) {
			for (const component of components) {
				expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
			}
		}
	});
});
