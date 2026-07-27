import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { compactPlanPath } from "./widgets.ts";

const ANNOTATION_VISUAL_LINE_BUDGET = 12;

export interface SubmitPlanCallArgs {
	planId?: string;
	title?: string;
	markdown?: string;
}

export interface CompletePlanCallArgs {
	planId?: string;
	revision?: number;
	summary?: string;
	verification?: string[];
}

export interface PlanToolDetails {
	kind?: string;
	planId?: string;
	revision?: number;
	planPath?: string;
	approvedHash?: string;
	title?: string;
	completedAt?: string;
	summary?: string;
	verification?: string[];
}

interface RenderResultLike {
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
}

interface ToolOutcome {
	details: PlanToolDetails;
	resultText: string;
	isError: boolean;
}

interface ToolDisplayState {
	outcome?: ToolOutcome;
	callComponent?: MutableCallComponent;
}

class MutableCallComponent implements Component {
	private renderLine: (width: number) => string | undefined = () => undefined;

	setRenderer(renderer: (width: number) => string | undefined): void {
		this.renderLine = renderer;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const line = this.renderLine(width);
		return line ? [truncateToWidth(line, width)] : [];
	}

	invalidate(): void {}
}

class DynamicLinesComponent implements Component {
	constructor(private readonly buildLines: (width: number) => string[]) {}

	render(width: number): string[] {
		if (width <= 0) return [];
		return this.buildLines(width).map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}
}

function emptyComponent(): Component {
	return new Container();
}

function textContent(result: RenderResultLike): string {
	return result.content
		?.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n") ?? "";
}

function toolDetails(value: unknown): PlanToolDetails {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as PlanToolDetails;
}

function titleOf(args: SubmitPlanCallArgs | undefined): string {
	return args?.title?.trim() || "Plan";
}

function metadataSuffix(title: string, revision?: number): string {
	return `${title}${Number.isInteger(revision) && revision! > 0 ? ` · r${revision}` : ""}`;
}

function failureSummary(text: string, fallback: string): string {
	const firstLine = text.trim().split(/\r?\n/, 1)[0]?.trim();
	if (!firstLine) return fallback;
	const colon = firstLine.indexOf(":");
	return (colon >= 0 ? firstLine.slice(colon + 1) : firstLine).trim() || fallback;
}

function isSubmitFailure(kind: string | undefined, isError: boolean): boolean {
	return isError || ["unavailable", "invalid", "invalid_plan_id", "storage_error", "integrity_error", "error"].includes(kind ?? "");
}

function expandAuditHint(): string {
	try {
		return keyHint("app.tools.expand", "to inspect");
	} catch {
		return "Ctrl+O to inspect";
	}
}

function formatSubmitCall(
	args: SubmitPlanCallArgs | undefined,
	outcome: ToolOutcome | undefined,
	expanded: boolean,
	theme: Theme,
	width: number,
): string | undefined {
	const title = titleOf(args);
	if (!outcome) {
		const prefix = theme.fg("accent", "● Reviewing Plan");
		const suffix = theme.fg("muted", `: ${title}…`);
		return `${prefix}${truncateToWidth(suffix, Math.max(0, width - 18))}`;
	}

	const { details, resultText, isError } = outcome;
	const suffix = metadataSuffix(title, details.revision);
	if (details.kind === "approved") {
		if (!expanded) return undefined;
		return `${theme.fg("toolTitle", theme.bold("Submit Plan"))}${theme.fg("muted", ` · ${suffix}`)}`;
	}
	if (details.kind === "changes_requested") {
		return `${theme.fg("warning", "● Plan changes requested")}${theme.fg("muted", ` · ${suffix}`)}`;
	}
	if (details.kind === "keep_planning") {
		return `${theme.fg("accent", "● Plan review kept as draft")}${theme.fg("muted", ` · ${suffix}`)}`;
	}
	if (details.kind === "cancelled") {
		return `${theme.fg("warning", "● Plan review cancelled")}${theme.fg("muted", ` · ${suffix}`)}`;
	}
	if (isSubmitFailure(details.kind, isError)) {
		return `${theme.fg("error", "✗ Plan submission failed")}${theme.fg("muted", ` · ${failureSummary(resultText, details.kind ?? "error")}`)}`;
	}
	return `${theme.fg("accent", "● Plan submitted")}${theme.fg("muted", ` · ${suffix}`)}`;
}

interface ParsedAnnotations {
	raw: string;
	items?: string[];
}

export function parseReviewAnnotations(resultText: string): ParsedAnnotations | undefined {
	const separator = resultText.indexOf("\n\n");
	if (separator < 0) return undefined;
	const raw = resultText.slice(separator + 2).trim();
	if (!raw) return undefined;
	const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
	const listItems = lines.map((line) => /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+?)\s*$/.exec(line));
	if (listItems.length > 0 && listItems.every((item) => item !== null)) {
		return { raw, items: listItems.map((item) => item![1]!.trim()) };
	}
	return { raw };
}

function wrapLine(line: string, width: number): string[] {
	return wrapTextWithAnsi(line, Math.max(1, width));
}

function renderAnnotationLines(parsed: ParsedAnnotations, width: number, theme: Theme): string[] {
	const sourceLines: string[] = [];
	if (parsed.items) {
		for (const [index, item] of parsed.items.entries()) {
			sourceLines.push(...wrapLine(`${theme.fg("accent", `  ${index + 1}. `)}${theme.fg("muted", item)}`, width));
		}
	} else {
		for (const line of parsed.raw.split(/\r?\n/)) {
			if (!line.trim()) continue;
			sourceLines.push(...wrapLine(theme.fg("muted", `  ${line.trim()}`), width));
		}
	}
	if (sourceLines.length <= ANNOTATION_VISUAL_LINE_BUDGET) return sourceLines;
	const visible = sourceLines.slice(0, ANNOTATION_VISUAL_LINE_BUDGET);
	visible.push(theme.fg("dim", `  … +${sourceLines.length - ANNOTATION_VISUAL_LINE_BUDGET} more lines`));
	return visible;
}

function auditMetadata(details: PlanToolDetails, theme: Theme): string[] {
	const lines: string[] = [];
	if (details.planId) lines.push(theme.fg("dim", `  Plan ID: ${details.planId}`));
	if (details.planPath) lines.push(theme.fg("dim", `  Plan: ${compactPlanPath(details.planPath)}`));
	if (details.approvedHash) lines.push(theme.fg("dim", `  Approved hash: ${details.approvedHash}`));
	return lines;
}

function renderSubmitResultLines(
	outcome: ToolOutcome,
	expanded: boolean,
	theme: Theme,
	width: number,
): string[] {
	const { details, resultText, isError } = outcome;
	if (details.kind === "approved") return expanded ? auditMetadata(details, theme) : [];

	if (details.kind === "changes_requested") {
		const parsed = parseReviewAnnotations(resultText);
		if (!expanded) {
			const summary = parsed?.items
				? `${parsed.items.length} ${parsed.items.length === 1 ? "annotation" : "annotations"}`
				: "Review annotations available";
			return [theme.fg("dim", `  ⎿ ${summary} · ${expandAuditHint()}`)];
		}
		const lines = [theme.fg("muted", "  Annotations")];
		if (parsed) lines.push(...renderAnnotationLines(parsed, width, theme));
		else lines.push(theme.fg("dim", "  Review feedback is stored in the tool result."));
		lines.push(...auditMetadata(details, theme));
		return lines;
	}

	if (expanded) {
		const lines: string[] = [];
		if (resultText.trim()) lines.push(...wrapLine(theme.fg(isSubmitFailure(details.kind, isError) ? "error" : "muted", `  ${resultText.trim()}`), width));
		lines.push(...auditMetadata(details, theme));
		return lines;
	}
	return [];
}

export function renderSubmitPlanCall(
	args: SubmitPlanCallArgs,
	theme: Theme,
	context: { state: ToolDisplayState; lastComponent?: Component; expanded?: boolean },
): Component {
	const component = context.lastComponent instanceof MutableCallComponent
		? context.lastComponent
		: new MutableCallComponent();
	context.state.callComponent = component;
	component.setRenderer((width) => formatSubmitCall(args, context.state.outcome, context.expanded === true, theme, width));
	return component;
}

export function renderSubmitPlanResult(
	result: RenderResultLike,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: { state: ToolDisplayState; args: SubmitPlanCallArgs; isError: boolean; expanded?: boolean },
): Component {
	if (options.isPartial) return emptyComponent();
	const outcome: ToolOutcome = {
		details: toolDetails(result.details),
		resultText: textContent(result),
		isError: context.isError,
	};
	context.state.outcome = outcome;
	context.state.callComponent?.setRenderer((width) =>
		formatSubmitCall(context.args, outcome, options.expanded, theme, width));
	return new DynamicLinesComponent((width) => renderSubmitResultLines(outcome, options.expanded, theme, width));
}

function formatCompleteCall(
	args: CompletePlanCallArgs | undefined,
	outcome: ToolOutcome | undefined,
	expanded: boolean,
	theme: Theme,
): string | undefined {
	const revision = Number.isInteger(args?.revision) && args!.revision! > 0 ? ` · r${args!.revision}` : "";
	if (!outcome) return `${theme.fg("accent", "● Completing Plan")}${theme.fg("muted", revision)}`;
	if (outcome.details.kind === "completed") {
		if (!expanded) return undefined;
		return `${theme.fg("toolTitle", theme.bold("Complete Plan"))}${theme.fg("muted", revision)}`;
	}
	return `${theme.fg("error", "✗ Plan completion failed")}${theme.fg("muted", ` · ${failureSummary(outcome.resultText, "error")}`)}`;
}

function renderCompleteResultLines(outcome: ToolOutcome, expanded: boolean, theme: Theme, width: number): string[] {
	if (outcome.details.kind === "completed") {
		if (!expanded) return [];
		const lines: string[] = [];
		if (outcome.details.summary) lines.push(...wrapLine(theme.fg("muted", `  Summary: ${outcome.details.summary}`), width));
		for (const item of outcome.details.verification ?? []) {
			lines.push(...wrapLine(theme.fg("dim", `  Verified: ${item}`), width));
		}
		lines.push(...auditMetadata(outcome.details, theme));
		if (outcome.details.completedAt) lines.push(theme.fg("dim", `  Completed: ${outcome.details.completedAt}`));
		return lines;
	}
	return expanded && outcome.resultText ? wrapLine(theme.fg("error", `  ${outcome.resultText}`), width) : [];
}

export function renderCompletePlanCall(
	args: CompletePlanCallArgs,
	theme: Theme,
	context: { state: ToolDisplayState; lastComponent?: Component; expanded?: boolean },
): Component {
	const component = context.lastComponent instanceof MutableCallComponent
		? context.lastComponent
		: new MutableCallComponent();
	context.state.callComponent = component;
	component.setRenderer(() => formatCompleteCall(args, context.state.outcome, context.expanded === true, theme));
	return component;
}

export function renderCompletePlanResult(
	result: RenderResultLike,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: { state: ToolDisplayState; args: CompletePlanCallArgs; isError: boolean },
): Component {
	if (options.isPartial) return emptyComponent();
	const outcome: ToolOutcome = {
		details: toolDetails(result.details),
		resultText: textContent(result),
		isError: context.isError,
	};
	context.state.outcome = outcome;
	context.state.callComponent?.setRenderer(() => formatCompleteCall(context.args, outcome, options.expanded, theme));
	return new DynamicLinesComponent((width) => renderCompleteResultLines(outcome, options.expanded, theme, width));
}

export function renderHiddenPlanToolNode(): Text {
	return new Text("", 0, 0);
}
