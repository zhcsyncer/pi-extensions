import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderAskUserQuestionCall, renderAskUserQuestionResult } from "./tool-renderer.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

const args = {
	questions: [
		{
			question: "Which layout should we use?",
			header: "Layout",
			options: [
				{
					label: "Centered",
					description: "Keeps the primary action visually balanced.",
					preview: "# Centered\n\n[ logo ]\n[ action ]",
				},
				{ label: "Left aligned", description: "Matches the existing navigation edge." },
			],
		},
	],
};

function textOf(component: { render(width: number): string[] }, width = 100): string {
	return component
		.render(width)
		.map((line) => line.trimEnd())
		.join("\n");
}

describe("renderAskUserQuestionCall", () => {
	it("shows complete questions, option labels, and descriptions by default", () => {
		const output = textOf(renderAskUserQuestionCall(args, theme, false));
		expect(output).toContain("ask_user_question · 1 question");
		expect(output).toContain("1. Layout Which layout should we use?");
		expect(output).toContain("1. Centered · has preview");
		expect(output).toContain("Keeps the primary action visually balanced.");
		expect(output).toContain("3. Type something.");
		expect(output).not.toContain("[ logo ]");
	});

	it("reveals bounded preview content when expanded", () => {
		const output = textOf(renderAskUserQuestionCall(args, theme, true));
		expect(output).toContain("Preview:");
		expect(output).toContain("[ logo ]");

		const longPreview = textOf(
			renderAskUserQuestionCall(
				{
					questions: [
						{
							question: "Preview?",
							header: "Preview",
							options: [
								{ label: "A", description: "First", preview: `VISIBLE-${"x".repeat(3000)}` },
								{ label: "B", description: "Second" },
							],
						},
					],
				},
				theme,
				true,
			),
			4000,
		);
		expect(longPreview).toContain("VISIBLE-");
		expect(longPreview).toContain("preview truncated");
	});

	it("sanitizes terminal control sequences and respects render width", () => {
		const component = renderAskUserQuestionCall(
			{
				questions: [
					{
						question: "Safe?\u001b[31m\u009b\u202e",
						header: "Safety",
						options: [
							{ label: "A", description: "A long explanation that should wrap without crossing width." },
							{ label: "B", description: "Second" },
						],
					},
				],
			},
			theme,
			false,
		);
		const lines = component.render(32);
		const output = lines.join("\n");
		expect(output).not.toContain("\u001b[31m");
		expect(output).not.toContain("\u009b");
		expect(output).not.toContain("\u202e");
		expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
	});

	it("bounds untrusted question and description text", () => {
		const output = textOf(
			renderAskUserQuestionCall(
				{
					questions: [
						{
							question: "q".repeat(1000),
							header: "Long",
							options: [
								{ label: "A", description: "d".repeat(2000) },
								{ label: "B", description: "Second" },
							],
						},
					],
				},
				theme,
				false,
			),
			2000,
		);
		expect(output).toContain("…");
		expect(output.length).toBeLessThan(1400);
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
				{ content: [{ type: "text", text: "e".repeat(5000) }] },
				theme,
				{ expanded: false, isPartial: false },
				true,
			),
			4000,
		);
		expect(errorOutput).toContain("…");
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
