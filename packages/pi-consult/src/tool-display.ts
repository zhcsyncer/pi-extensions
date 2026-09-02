import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { isRecord, type ConsultDetails, type ConsultEnvelope, type ConsultVerdict } from "./types.ts";

const TOOL_LABEL = "Consult";

export interface ConsultRenderContext {
	isError?: boolean;
	isPartial?: boolean;
	args?: unknown;
}

export interface ConsultRenderResult {
	details?: unknown;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function whyFromArgs(args: unknown): string {
	if (!isRecord(args) || typeof args.why !== "string") return "";
	return oneLine(args.why);
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

export function renderConsultCall(args: { why?: string }, theme: Theme, context: ConsultRenderContext): Component {
	return new Text(formatConsultCallLine(args, theme, context), 0, 0);
}

function envelopeFromResult(result: ConsultRenderResult): ConsultEnvelope | undefined {
	if (!isRecord(result.details) || !isRecord(result.details.envelope)) return undefined;
	const envelope = result.details.envelope;
	if (typeof envelope.verdict !== "string" || typeof envelope.summary !== "string") return undefined;
	return envelope as unknown as ConsultEnvelope;
}

function modelsFromResult(result: ConsultRenderResult): string[] {
	if (!isRecord(result.details) || !Array.isArray(result.details.models)) return [];
	return result.details.models.filter((model): model is string => typeof model === "string");
}

function verdictColor(theme: Theme, verdict: ConsultVerdict | "failed"): string {
	if (verdict === "stop" || verdict === "failed") return theme.fg("error", verdict);
	if (verdict === "correction" || verdict === "split") return theme.fg("warning", verdict);
	return theme.fg("success", verdict);
}

export function consultResultLines(
	result: ConsultRenderResult,
	options: { expanded: boolean },
	theme: Theme,
	context?: ConsultRenderContext,
): string[] {
	const envelope = envelopeFromResult(result);
	const failed = Boolean(context?.isError || envelope?.error);
	const verdict: ConsultVerdict | "failed" = failed ? "failed" : (envelope?.verdict ?? "plan");
	const summary = oneLine(envelope?.error || envelope?.summary || "");
	const head = summary ? `${verdictColor(theme, verdict)} · ${theme.fg("text", summary)}` : verdictColor(theme, verdict);
	if (!options.expanded) return [head];

	const lines = [verdictColor(theme, verdict)];
	const why = whyFromArgs(context?.args);
	if (why) lines.push(theme.fg("muted", why));
	const models = modelsFromResult(result);
	if (models.length) lines.push(theme.fg("muted", models.join(" + ")));
	if (envelope?.summary) lines.push(theme.fg("text", envelope.summary));
	if (envelope?.conflicts) {
		for (const conflict of envelope.conflicts) lines.push(theme.fg("warning", conflict));
	}
	return lines;
}

class ClaudeResultComponent implements Component {
	constructor(private readonly lines: string[]) {}

	render(width: number): string[] {
		if (width <= 0 || this.lines.length === 0) return [];
		return this.lines.map((line, index) => {
			const prefix = index === 0 ? "  ⎿ " : "    ";
			return truncateToWidth(`${prefix}${line}`, width, "");
		});
	}

	invalidate(): void {}
}

export function renderConsultResult(
	result: ConsultRenderResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: ConsultRenderContext,
): Component {
	return new ClaudeResultComponent(consultResultLines(result, options, theme, context));
}
