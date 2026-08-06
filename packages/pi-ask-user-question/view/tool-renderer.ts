import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatAnswerScalar } from "../tool/format-answer.js";
import type { QuestionAnswer, QuestionnaireResult } from "../tool/types.js";

const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[@-_])/gu;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
const QUESTION_CHAR_LIMIT = 400;
const DESCRIPTION_CHAR_LIMIT = 600;
const ANSWER_CHAR_LIMIT = 1200;
const NOTES_CHAR_LIMIT = 800;
const FALLBACK_CHAR_LIMIT = 2000;
const PREVIEW_LINE_LIMIT = 12;
const PREVIEW_CHAR_LIMIT = 2000;

interface RenderOption {
	label: string;
	description: string;
	preview?: string;
}

interface RenderQuestion {
	question: string;
	header: string;
	options: RenderOption[];
	multiSelect: boolean;
}

interface ToolResultLike {
	content?: ReadonlyArray<{ type?: string; text?: string }>;
	details?: unknown;
}

function truncateText(value: string, limit: number): string {
	const characters = Array.from(value);
	if (characters.length <= limit) return value;
	return `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

function safeText(value: unknown, preserveNewlines = false, limit = Number.POSITIVE_INFINITY): string {
	if (typeof value !== "string") return "";
	const clean = value.replace(ANSI_SEQUENCE, "").replace(UNSAFE_CONTROL, "").replace(/\r\n?/gu, "\n");
	const normalized = preserveNewlines ? clean : clean.replace(/\s+/gu, " ").trim();
	return Number.isFinite(limit) ? truncateText(normalized, limit) : normalized;
}

function readQuestions(args: unknown): RenderQuestion[] {
	if (!args || typeof args !== "object") return [];
	const questions = (args as { questions?: unknown }).questions;
	if (!Array.isArray(questions)) return [];

	const out: RenderQuestion[] = [];
	for (const candidate of questions) {
		if (!candidate || typeof candidate !== "object") continue;
		const raw = candidate as Record<string, unknown>;
		const options: RenderOption[] = [];
		if (Array.isArray(raw.options)) {
			for (const option of raw.options) {
				if (!option || typeof option !== "object") continue;
				const value = option as Record<string, unknown>;
				const label = safeText(value.label, false, 120);
				if (!label) continue;
				const preview = safeText(value.preview, true, PREVIEW_CHAR_LIMIT + 1);
				options.push({
					label,
					description: safeText(value.description, false, DESCRIPTION_CHAR_LIMIT),
					...(preview ? { preview } : {}),
				});
			}
		}
		out.push({
			question: safeText(raw.question, false, QUESTION_CHAR_LIMIT),
			header: safeText(raw.header, false, 32),
			options,
			multiSelect: raw.multiSelect === true,
		});
	}
	return out;
}

function formatPreview(preview: string): { text: string; truncated: boolean } {
	const sourceLines = preview.split("\n");
	const kept: string[] = [];
	let chars = 0;
	let truncated = false;
	for (const line of sourceLines) {
		if (kept.length >= PREVIEW_LINE_LIMIT) {
			truncated = true;
			break;
		}
		const separatorWidth = kept.length > 0 ? 1 : 0;
		const remaining = PREVIEW_CHAR_LIMIT - chars - separatorWidth;
		if (remaining <= 0) {
			truncated = true;
			break;
		}
		if (Array.from(line).length > remaining) {
			kept.push(truncateText(line, remaining));
			truncated = true;
			break;
		}
		kept.push(line);
		chars += separatorWidth + Array.from(line).length;
	}
	if (kept.length < sourceLines.length) truncated = true;
	return { text: kept.join("\n"), truncated };
}

export function renderAskUserQuestionCall(args: unknown, theme: Theme, expanded: boolean): Text {
	const questions = readQuestions(args);
	const lines: string[] = [
		`${theme.fg("toolTitle", theme.bold("ask_user_question"))}${theme.fg(
			"muted",
			` · ${questions.length} question${questions.length === 1 ? "" : "s"}`,
		)}`,
	];

	for (let questionIndex = 0; questionIndex < questions.length; questionIndex++) {
		const question = questions[questionIndex]!;
		lines.push("");
		const header = question.header || `Q${questionIndex + 1}`;
		const mode = question.multiSelect ? theme.fg("muted", " [multi-select]") : "";
		lines.push(
			`${theme.fg("accent", theme.bold(`${questionIndex + 1}. ${header}`))}${mode} ${theme.fg(
				"text",
				question.question || "(question incomplete)",
			)}`,
		);

		for (let optionIndex = 0; optionIndex < question.options.length; optionIndex++) {
			const option = question.options[optionIndex]!;
			const previewMarker = option.preview ? theme.fg("dim", expanded ? " · preview" : " · has preview") : "";
			lines.push(
				`   ${theme.fg("accent", `${optionIndex + 1}.`)} ${theme.fg("text", option.label)}${previewMarker}`,
			);
			if (option.description) lines.push(`      ${theme.fg("muted", option.description)}`);
			if (expanded && option.preview) {
				const preview = formatPreview(option.preview);
				lines.push(`      ${theme.fg("dim", "Preview:")}`);
				for (const previewLine of preview.text.split("\n")) {
					lines.push(`        ${theme.fg("dim", previewLine)}`);
				}
				if (preview.truncated) lines.push(`        ${theme.fg("dim", "… preview truncated")}`);
			}
		}
		lines.push(`   ${theme.fg("dim", `${question.options.length + 1}. Type something.`)}`);
	}

	return new Text(lines.join("\n"), 0, 0);
}

function isQuestionnaireResult(value: unknown): value is QuestionnaireResult {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<QuestionnaireResult>;
	return Array.isArray(details.answers) && typeof details.cancelled === "boolean";
}

function resultText(result: ToolResultLike): string {
	const combined = (result.content ?? [])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => safeText(part.text, true, FALLBACK_CHAR_LIMIT))
		.join("\n")
		.trim();
	return truncateText(combined, FALLBACK_CHAR_LIMIT);
}

function answerLabel(answer: QuestionAnswer): string {
	const formatted = safeText(formatAnswerScalar(answer, "summary"), false, ANSWER_CHAR_LIMIT);
	if (answer.kind === "custom") return `${formatted || "(no input)"} (custom)`;
	if (answer.kind === "multi") return `${formatted || "(none)"} (multi-select)`;
	return formatted || "(no input)";
}

export function renderAskUserQuestionResult(
	result: ToolResultLike,
	theme: Theme,
	options: { expanded: boolean; isPartial: boolean },
	isError: boolean,
): Text {
	if (options.isPartial) return new Text(theme.fg("warning", "Waiting for the user's answers…"), 0, 0);

	const details = isQuestionnaireResult(result.details) ? result.details : undefined;
	const fallback = resultText(result);
	if (isError || details?.error) {
		const code = details?.error ? ` (${details.error})` : "";
		return new Text(
			`${theme.fg("error", `✗ Questionnaire failed${code}`)}${fallback ? `\n${theme.fg("muted", fallback)}` : ""}`,
			0,
			0,
		);
	}

	if (!details) return new Text(fallback, 0, 0);

	const lines: string[] = [];
	if (details.cancelled) {
		lines.push(theme.fg("warning", "○ User cancelled the questionnaire"));
		if (details.answers.length > 0) {
			lines.push(theme.fg("muted", `  ${details.answers.length} partial answer${details.answers.length === 1 ? "" : "s"}:`));
		}
	} else {
		lines.push(
			theme.fg(
				"success",
				`✓ ${details.answers.length} answer${details.answers.length === 1 ? "" : "s"} received`,
			),
		);
	}

	for (const answer of details.answers) {
		const number = Number.isInteger(answer.questionIndex) ? answer.questionIndex + 1 : "?";
		lines.push(
			`  ${theme.fg("accent", `${number}.`)} ${theme.fg("text", safeText(answer.question, false, QUESTION_CHAR_LIMIT))}`,
		);
		lines.push(`     ${theme.fg("muted", "→")} ${theme.fg("text", answerLabel(answer))}`);
		if (answer.notes) {
			lines.push(`     ${theme.fg("dim", `Notes: ${safeText(answer.notes, false, NOTES_CHAR_LIMIT)}`)}`);
		}
		if (options.expanded && answer.preview) {
			const preview = formatPreview(safeText(answer.preview, true, PREVIEW_CHAR_LIMIT + 1));
			lines.push(`     ${theme.fg("dim", "Selected preview:")}`);
			for (const previewLine of preview.text.split("\n")) lines.push(`       ${theme.fg("dim", previewLine)}`);
			if (preview.truncated) lines.push(`       ${theme.fg("dim", "… preview truncated")}`);
		}
	}

	return new Text(lines.join("\n"), 0, 0);
}
