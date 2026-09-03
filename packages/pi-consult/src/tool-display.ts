import { getMarkdownTheme, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { ConsultAdoption } from "./events.ts";
import { isRecord, type ConsultEnvelope, type ConsultOutcome, type ConsultVerdict } from "./types.ts";

const TOOL_LABEL = "Consult";
const RESULT_FIRST_PREFIX = "  ⎿ ";
const RESULT_CONT_PREFIX = "    ";
const ELAPSED_STATE_KEY = "__piConsultElapsed";

export interface ConsultRenderContext {
	isError?: boolean;
	isPartial?: boolean;
	expanded?: boolean;
	args?: unknown;
	toolCallId?: string;
	adoption?: ConsultAdoption;
	invalidate?: () => void;
	state?: unknown;
	lastComponent?: unknown;
}

export interface ConsultRenderResult {
	details?: unknown;
}

interface ElapsedState {
	startedAt: number;
	timer?: ReturnType<typeof setInterval>;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function markdownPreview(value: string): string {
	const code: string[] = [];
	const protect = (content: string): string => {
		const index = code.push(oneLine(content)) - 1;
		return `\uE000${index}\uE001`;
	};
	const preview = oneLine(
		value
			.replace(/```[^\n]*\n([\s\S]*?)```/g, (_match, content: string) => protect(content))
			.replace(/`([^`\n]+)`/g, (_match, content: string) => protect(content))
			.replace(/```[^\n]*\n?/g, "")
			.replace(/^\s{0,3}(?:#{1,6}\s+|>\s+|[-+*]\s+|\d+[.)]\s+)/gm, "")
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
			.replace(/(\*\*|~~)(.*?)\1/g, "$2")
			.replace(/(^|[^\w])(\*)([^*\n]+)\2(?!\w)/g, "$1$3"),
	);
	return preview.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => code[Number(index)] ?? "");
}

function whyFromArgs(args: unknown): string {
	if (!isRecord(args) || typeof args.why !== "string") return "";
	return oneLine(args.why);
}

function detailsRecord(result: ConsultRenderResult): Record<string, unknown> | undefined {
	return isRecord(result.details) ? result.details : undefined;
}

function envelopeFromResult(result: ConsultRenderResult): ConsultEnvelope | undefined {
	const details = detailsRecord(result);
	if (!details || !isRecord(details.envelope)) return undefined;
	const envelope = details.envelope;
	if (typeof envelope.verdict !== "string" || typeof envelope.summary !== "string") return undefined;
	return envelope as unknown as ConsultEnvelope;
}

function modelsFromResult(result: ConsultRenderResult): string[] {
	const details = detailsRecord(result);
	if (!details || !Array.isArray(details.models)) return [];
	return details.models.filter((model): model is string => typeof model === "string");
}

function effortFromResult(result: ConsultRenderResult): string | undefined {
	const details = detailsRecord(result);
	return typeof details?.effort === "string" && details.effort.trim() ? details.effort.trim() : undefined;
}

function claudeMarker(theme: Theme, context?: ConsultRenderContext): string {
	if (context?.isError) return theme.fg("error", "●");
	if (context?.isPartial) return theme.fg("warning", "●");
	return theme.fg("success", "●");
}

export function formatConsultCallLine(args: unknown, theme: Theme, context?: ConsultRenderContext): string {
	const why = whyFromArgs(args) || "…";
	return `${claudeMarker(theme, context)} ${theme.fg("toolTitle", theme.bold(TOOL_LABEL))}(${why})`;
}

function expandHint(): string {
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		return "Ctrl+O to expand";
	}
}

export function formatElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) return `${totalMinutes}m ${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

function elapsedCarrier(state: unknown): Record<string, unknown> | undefined {
	return isRecord(state) ? state : undefined;
}

export function tickElapsed(context: ConsultRenderContext | undefined, isPartial: boolean): number {
	const carrier = elapsedCarrier(context?.state);
	if (!isPartial) {
		const elapsed = carrier?.[ELAPSED_STATE_KEY];
		if (isRecord(elapsed) && elapsed.timer) {
			clearInterval(elapsed.timer as ReturnType<typeof setInterval>);
			elapsed.timer = undefined;
		}
		return 0;
	}
	if (!carrier) return 0;
	let elapsed = carrier[ELAPSED_STATE_KEY] as ElapsedState | undefined;
	if (!elapsed || typeof elapsed.startedAt !== "number") {
		elapsed = { startedAt: Date.now() };
		carrier[ELAPSED_STATE_KEY] = elapsed;
	}
	if (!elapsed.timer && typeof context?.invalidate === "function") {
		elapsed.timer = setInterval(() => context.invalidate?.(), 1000);
	}
	return Date.now() - elapsed.startedAt;
}

type ConsultDisplayStatus = ConsultVerdict | Exclude<ConsultOutcome, "completed">;

function outcomeFromResult(
	result: ConsultRenderResult,
	context: ConsultRenderContext | undefined,
	envelope: ConsultEnvelope | undefined,
): ConsultOutcome {
	const outcome = detailsRecord(result)?.outcome;
	if (outcome === "completed" || outcome === "blocked" || outcome === "failed" || outcome === "cancelled") {
		return outcome;
	}
	return context?.isError || envelope?.error ? "failed" : "completed";
}

function statusColor(theme: Theme, status: ConsultDisplayStatus): string {
	if (status === "stop" || status === "failed") return theme.fg("error", status);
	if (status === "correction" || status === "split" || status === "blocked") return theme.fg("warning", status);
	if (status === "cancelled") return theme.fg("muted", status);
	return theme.fg("success", status);
}

function consultingLine(result: ConsultRenderResult, theme: Theme, elapsedMs: number): string {
	const models = modelsFromResult(result).join(" + ");
	const effort = effortFromResult(result);
	let text = "consulting";
	if (models) text += ` ${models}`;
	if (effort) text += ` · ${effort}`;
	text += `  ${formatElapsed(elapsedMs)}`;
	return theme.fg("muted", text);
}

function adoptionLine(adoption: ConsultAdoption, theme: Theme): string {
	const decision = adoption.adopted ? theme.fg("success", "adopt") : theme.fg("warning", "reject");
	return adoption.reason ? `${decision}${theme.fg("muted", ` · ${adoption.reason}`)}` : decision;
}

export function consultResultLines(
	result: ConsultRenderResult,
	options: { expanded: boolean; isPartial?: boolean },
	theme: Theme,
	context?: ConsultRenderContext,
	elapsedMs = 0,
): string[] {
	if (options.isPartial || context?.isPartial) return [consultingLine(result, theme, elapsedMs)];

	const envelope = envelopeFromResult(result);
	const outcome = outcomeFromResult(result, context, envelope);
	const completed = outcome === "completed";
	const status: ConsultDisplayStatus = completed ? (envelope?.verdict ?? "plan") : outcome;
	const summary = markdownPreview(envelope?.error || envelope?.summary || "");

	const adoption = completed ? context?.adoption : undefined;
	if (!options.expanded) {
		const lines = [summary ? `${statusColor(theme, status)} · ${theme.fg("text", summary)}` : statusColor(theme, status)];
		if (adoption) lines.push(adoptionLine(adoption, theme));
		return lines;
	}

	const lines = [statusColor(theme, status)];
	if (envelope?.summary && completed) lines.push(theme.fg("text", envelope.summary));
	if (!completed && envelope?.error) lines.push(theme.fg("text", envelope.error));
	if (completed && envelope?.conflicts) {
		for (const conflict of envelope.conflicts) lines.push(theme.fg("warning", conflict));
	}
	if (adoption) lines.push(adoptionLine(adoption, theme));
	const models = modelsFromResult(result);
	if (models.length) lines.push(theme.fg("muted", models.join(" + ")));
	return lines;
}

class ConsultCallComponent implements Component {
	constructor(
		private readonly args: unknown,
		private readonly theme: Theme,
		private readonly context?: ConsultRenderContext,
	) {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const line = formatConsultCallLine(this.args, this.theme, this.context);
		if (this.context?.expanded) return wrapTextWithAnsi(line, width);
		return [truncateToWidth(line, width, "…")];
	}

	invalidate(): void {}
}

function expandedResultRows(
	result: ConsultRenderResult,
	theme: Theme,
	context: ConsultRenderContext,
	width: number,
): string[] {
	const envelope = envelopeFromResult(result);
	const outcome = outcomeFromResult(result, context, envelope);
	const completed = outcome === "completed";
	const status: ConsultDisplayStatus = completed ? (envelope?.verdict ?? "plan") : outcome;
	const rows: string[] = [];
	const appendPlain = (text: string, first = false): void => {
		const prefix = first ? RESULT_FIRST_PREFIX : RESULT_CONT_PREFIX;
		const wrapped = wrapTextWithAnsi(text, Math.max(1, width - visibleWidth(prefix)));
		for (const row of wrapped) rows.push(truncateToWidth(`${prefix}${row}`, width, ""));
	};

	appendPlain(statusColor(theme, status), true);
	if (completed && envelope?.summary) {
		const prefix = RESULT_CONT_PREFIX;
		const markdown = new Markdown(envelope.summary, 0, 0, getMarkdownTheme());
		for (const row of markdown.render(Math.max(1, width - visibleWidth(prefix)))) {
			rows.push(truncateToWidth(`${prefix}${row}`, width, ""));
		}
	} else if (!completed && envelope?.error) {
		appendPlain(theme.fg("text", envelope.error));
	}
	if (completed && envelope?.conflicts) {
		for (const conflict of envelope.conflicts) appendPlain(theme.fg("warning", conflict));
	}
	if (completed && context.adoption) appendPlain(adoptionLine(context.adoption, theme));
	const models = modelsFromResult(result);
	if (models.length > 0) appendPlain(theme.fg("muted", models.join(" + ")));
	return rows;
}

class ConsultResultComponent implements Component {
	constructor(
		private result: ConsultRenderResult,
		private options: { expanded: boolean; isPartial: boolean },
		private theme: Theme,
		private context: ConsultRenderContext,
	) {}

	update(
		result: ConsultRenderResult,
		options: { expanded: boolean; isPartial: boolean },
		theme: Theme,
		context: ConsultRenderContext,
	): void {
		this.result = result;
		this.options = options;
		this.theme = theme;
		this.context = context;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const partial = this.options.isPartial || Boolean(this.context.isPartial);
		const elapsedMs = tickElapsed(this.context, partial);
		const logical = consultResultLines(this.result, this.options, this.theme, this.context, elapsedMs);
		if (logical.length === 0) return [];

		if (partial) {
			const rows: string[] = [];
			for (const [index, line] of logical.entries()) {
				const prefix = index === 0 ? RESULT_FIRST_PREFIX : RESULT_CONT_PREFIX;
				for (const row of wrapTextWithAnsi(line, Math.max(1, width - visibleWidth(prefix)))) {
					rows.push(truncateToWidth(`${prefix}${row}`, width, ""));
				}
			}
			return rows;
		}
		if (this.options.expanded) return expandedResultRows(this.result, this.theme, this.context, width);

		const hint = ` (${expandHint()})`;
		return logical.map((line, index) => {
			const prefix = index === 0 ? RESULT_FIRST_PREFIX : RESULT_CONT_PREFIX;
			const suffix = index === logical.length - 1 ? hint : "";
			const budget = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
			const shown = truncateToWidth(line, budget, "…");
			return truncateToWidth(`${prefix}${shown}${suffix ? this.theme.fg("muted", suffix) : ""}`, width, "");
		});
	}

	invalidate(): void {}
}

export function renderConsultCall(args: { why?: string }, theme: Theme, context: ConsultRenderContext): Component {
	return new ConsultCallComponent(args, theme, context);
}

export function renderConsultResult(
	result: ConsultRenderResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: ConsultRenderContext,
): Component {
	if (context.lastComponent instanceof ConsultResultComponent) {
		context.lastComponent.update(result, options, theme, context);
		return context.lastComponent;
	}
	return new ConsultResultComponent(result, options, theme, context);
}
