import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { renderAskUserQuestionCall, renderAskUserQuestionResult } from "./tool-renderer.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

function textOf(component: { render(width: number): string[] }, width = 100): string {
	return component
		.render(width)
		.map((line) => line.trimEnd())
		.join("\n");
}

describe("renderAskUserQuestionCall", () => {
	it("stays invisible while the interactive questionnaire is active", () => {
		expect(renderAskUserQuestionCall().render(100)).toEqual([]);
	});
});

describe("renderAskUserQuestionResult", () => {
	it("renders answers and notes as an auditable result", () => {
		const output = textOf(
			renderAskUserQuestionResult(
				{
					details: {
						cancelled: false,
						answers: [
							{
								questionIndex: 0,
								question: "Which layout should we use?",
								kind: "option",
								answer: "Centered",
								notes: "Keep the CTA above the fold",
							},
						],
					},
				},
				theme,
				{ expanded: false, isPartial: false },
				false,
			),
		);
		expect(output).toContain("✓ 1 answer received");
		expect(output).toContain("Which layout should we use?");
		expect(output).toContain("→ Centered");
		expect(output).toContain("Notes: Keep the CTA above the fold");
	});

	it("keeps validation failures visible", () => {
		const output = textOf(
			renderAskUserQuestionResult(
				{
					content: [{ type: "text", text: "At least one question is required" }],
					details: { answers: [], cancelled: true, error: "no_questions" },
				},
				theme,
				{ expanded: false, isPartial: false },
				false,
			),
		);
		expect(output).toContain("Questionnaire failed (no_questions)");
		expect(output).toContain("At least one question is required");
	});

	it("bounds long answers, notes, and error fallback text", () => {
		const answerOutput = textOf(
			renderAskUserQuestionResult(
				{
					details: {
						cancelled: false,
						answers: [
							{
								questionIndex: 0,
								question: "Long?",
								kind: "custom",
								answer: "a".repeat(5000),
								notes: "n".repeat(5000),
							},
						],
					},
				},
				theme,
				{ expanded: false, isPartial: false },
				false,
			),
			4000,
		);
		expect(answerOutput).toContain("… (custom)");
		expect(answerOutput.length).toBeLessThan(2300);

		const errorOutput = textOf(
			renderAskUserQuestionResult(
				{ content: [{ type: "text", text: `\u001b[31m\u009b\u202e${"e".repeat(5000)}` }] },
				theme,
				{ expanded: false, isPartial: false },
				true,
			),
			4000,
		);
		expect(errorOutput).toContain("…");
		expect(errorOutput).not.toContain("\u001b[31m");
		expect(errorOutput).not.toContain("\u009b");
		expect(errorOutput).not.toContain("\u202e");
		expect(errorOutput.length).toBeLessThan(2100);
	});

	it("shows partial answers after cancellation", () => {
		const output = textOf(
			renderAskUserQuestionResult(
				{
					details: {
						cancelled: true,
						answers: [
							{ questionIndex: 1, question: "Scope?", kind: "custom", answer: "API only" },
						],
					},
				},
				theme,
				{ expanded: false, isPartial: false },
				false,
			),
		);
		expect(output).toContain("User cancelled");
		expect(output).toContain("1 partial answer");
		expect(output).toContain("API only (custom)");
	});
});
