import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { formatAnswerScalar } from "../tool/format-answer.js";
import type { QuestionAnswer, QuestionnaireResult } from "../tool/types.js";

const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[@-_])/gu;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
const QUESTION_CHAR_LIMIT = 400;
const ANSWER_CHAR_LIMIT = 1200;
const NOTES_CHAR_LIMIT = 800;
const FALLBACK_CHAR_LIMIT = 2000;
const PREVIEW_LINE_LIMIT = 12;
const PREVIEW_CHAR_LIMIT = 2000;

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

/**
 * Keep the transcript quiet while the interactive questionnaire owns the editor slot.
 * The tool uses Pi's self-render shell, so an empty container removes the pending call
 * completely; once execution finishes, renderAskUserQuestionResult becomes visible.
 */
export function renderAskUserQuestionCall(): Container {
	return new Container();
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
