import { describe, expect, it } from "vitest";
import { consultResultLines, formatConsultCallLine, renderConsultResult } from "../src/tool-display.ts";
import { errorEnvelope } from "../src/envelope.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

describe("consult Claude-style rows", () => {
	it("formats the call as ● Consult(why)", () => {
		expect(formatConsultCallLine({ why: "two approaches lock the layout" }, theme)).toBe(
			"● Consult(two approaches lock the layout)",
		);
		expect(formatConsultCallLine({ why: "x" }, theme, { isError: true })).toBe("● Consult(x)");
	});

	it("collapses the result to verdict · summary", () => {
		const lines = consultResultLines(
			{
				details: {
					trigger: "pull",
					models: ["anthropic/claude-fable-5"],
					envelope: { verdict: "correction", summary: "Stop editing parser.ts", raw: [] },
				},
			},
			{ expanded: false },
			theme,
		);
		expect(lines).toEqual(["correction · Stop editing parser.ts"]);
	});

	it("expands why, models, and conflicts", () => {
		const lines = consultResultLines(
			{
				details: {
					trigger: "loop",
					models: ["anthropic/claude-fable-5"],
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
		expect(lines).toContain("same bash failed twice");
		expect(lines).toContain("anthropic/claude-fable-5");
		expect(lines).toContain("a: plan — keep going");
	});

	it("prefixes result rows with the Claude ⎿ gutter", () => {
		const component = renderConsultResult(
			{
				details: {
					trigger: "pull",
					models: [],
					envelope: errorEnvelope("Budget exhausted for this turn."),
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			{ isError: true, args: { why: "x" } },
		);
		expect(component.render(80)[0]).toMatch(/^ {2}⎿ /);
	});
});
