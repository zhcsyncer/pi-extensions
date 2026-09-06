import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { MSG_CONSULT_LOG_HINT } from "./messages.ts";
import type {
	ConsultDetails,
	ConsultEnvelope,
	ConsultOutcome,
	ConsultRaw,
	ConsultTrigger,
	ConsultVerdict,
	UsageSnapshot,
} from "./types.ts";
import { isRecord } from "./types.ts";

const VERDICTS = new Set<ConsultVerdict>(["recommend", "confirm", "revise", "stop", "split"]);
const ADVISOR_VERDICTS = new Set<Exclude<ConsultVerdict, "split">>(["recommend", "confirm", "revise", "stop"]);

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
}

export function usageSnapshotFrom(usage: UsageLike | undefined): UsageSnapshot | undefined {
	if (!usage) return undefined;
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const cost = {
		input: usage.cost?.input ?? 0,
		output: usage.cost?.output ?? 0,
		cacheRead: usage.cost?.cacheRead ?? 0,
		cacheWrite: usage.cost?.cacheWrite ?? 0,
		total:
			usage.cost?.total ??
			(usage.cost?.input ?? 0) +
				(usage.cost?.output ?? 0) +
				(usage.cost?.cacheRead ?? 0) +
				(usage.cost?.cacheWrite ?? 0),
	};
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: usage.totalTokens ?? input + output + cacheRead + cacheWrite,
		cost,
		...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: usage.cacheWrite1h } : {}),
		...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
	};
}

export function addUsage(left: UsageSnapshot | undefined, right: UsageSnapshot | undefined): UsageSnapshot | undefined {
	if (!left) return right;
	if (!right) return left;
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
		...(left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined
			? { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }
			: {}),
		...(left.reasoning !== undefined || right.reasoning !== undefined
			? { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }
			: {}),
	};
}

export function hasUsage(usage: UsageSnapshot | undefined): usage is UsageSnapshot {
	return Boolean(
		usage &&
			(usage.input > 0 ||
				usage.output > 0 ||
				usage.cacheRead > 0 ||
				usage.cacheWrite > 0 ||
				usage.totalTokens > 0 ||
				usage.cost.total > 0),
	);
}

function extractJsonObject(text: string): unknown {
	const trimmed = text.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidate = (fenced?.[1] ?? trimmed).trim();
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		return JSON.parse(candidate.slice(start, end + 1)) as unknown;
	} catch {
		return undefined;
	}
}

export function parseAdvisorText(text: string): { verdict: Exclude<ConsultVerdict, "split">; summary: string } {
	const parsed = extractJsonObject(text);
	if (isRecord(parsed) && typeof parsed.summary === "string" && parsed.summary.trim()) {
		if (typeof parsed.verdict === "string" && ADVISOR_VERDICTS.has(parsed.verdict as Exclude<ConsultVerdict, "split">)) {
			return { verdict: parsed.verdict as Exclude<ConsultVerdict, "split">, summary: parsed.summary.trim() };
		}
	}
	const tagged = text.match(/\bverdict\s*[:=]\s*"?(recommend|confirm|revise|stop)"?/i);
	if (tagged) {
		return { verdict: tagged[1].toLowerCase() as Exclude<ConsultVerdict, "split">, summary: text.trim() };
	}
	return { verdict: "recommend", summary: text.trim() };
}

interface AdvisorMetadata {
	label: string;
	effort?: ConsultRaw["effort"];
	usage?: UsageSnapshot;
	durationMs: number;
	attempts: number;
}

export interface AdvisorSuccess extends AdvisorMetadata {
	ok: true;
	text: string;
}

export interface AdvisorFailure extends AdvisorMetadata {
	ok: false;
	error: string;
}

export type AdvisorOutcome = AdvisorSuccess | AdvisorFailure;

function toRaw(outcome: AdvisorOutcome): ConsultRaw {
	return {
		model: outcome.label,
		...(outcome.effort ? { effort: outcome.effort } : {}),
		text: outcome.ok ? outcome.text : outcome.error,
		...(outcome.usage ? { usage: outcome.usage } : {}),
		durationMs: outcome.durationMs,
		attempts: outcome.attempts,
	};
}

export function buildConsultEnvelope(opts: {
	verdict: ConsultVerdict;
	summary: string;
	raw?: ConsultRaw[];
	conflicts?: string[];
	error?: string;
}): ConsultEnvelope {
	const envelope: ConsultEnvelope = {
		verdict: VERDICTS.has(opts.verdict) ? opts.verdict : "recommend",
		summary: opts.summary,
		raw: opts.raw ?? [],
	};
	if (opts.conflicts && opts.conflicts.length > 0) envelope.conflicts = opts.conflicts;
	if (opts.error) envelope.error = opts.error;
	return envelope;
}

export function errorEnvelope(summary: string, error = summary, raw: ConsultRaw[] = []): ConsultEnvelope {
	return buildConsultEnvelope({ verdict: "recommend", summary, error, raw });
}

export function mergeAdvisorOutcomes(outcomes: AdvisorOutcome[]): ConsultEnvelope {
	const successes = outcomes.filter((outcome): outcome is AdvisorSuccess => outcome.ok);
	const failures = outcomes.filter((outcome): outcome is AdvisorFailure => !outcome.ok);
	if (successes.length === 0) {
		const summary = failures.map((failure) => `${failure.label}: ${failure.error}`).join("\n") || "Consult failed.";
		return errorEnvelope(summary, summary, outcomes.map(toRaw));
	}

	const parsed = successes.map((success) => ({ ...success, parsed: parseAdvisorText(success.text) }));
	const verdicts = new Set(parsed.map((item) => item.parsed.verdict));
	const raw = outcomes.map(toRaw);
	const allConstructive = parsed.every(
		(item) => item.parsed.verdict === "recommend" || item.parsed.verdict === "confirm",
	);

	if (verdicts.size === 1 || allConstructive) {
		const verdict = allConstructive
			? parsed.every((item) => item.parsed.verdict === "confirm")
				? "confirm"
				: "recommend"
			: parsed[0].parsed.verdict;
		const summaries = [...new Set(parsed.map((item) => item.parsed.summary))];
		return buildConsultEnvelope({
			verdict,
			summary: summaries.join("\n\n"),
			raw,
		});
	}

	const conflicts = parsed.map((item) => `${item.label}: ${item.parsed.verdict} — ${item.parsed.summary}`);
	return buildConsultEnvelope({
		verdict: "split",
		summary: "Advisors disagree. Surface the conflict and decide; do not silently pick a side.",
		conflicts,
		raw,
	});
}

export function formatConsultResultText(envelope: ConsultEnvelope, outcome: ConsultOutcome): string {
	const payload = {
		outcome,
		verdict: envelope.verdict,
		summary: envelope.summary,
		...(envelope.conflicts ? { conflicts: envelope.conflicts } : {}),
		...(envelope.error ? { error: envelope.error } : {}),
		raw: envelope.raw,
	};
	if (outcome !== "completed") return JSON.stringify(payload, null, 2);
	const splitHint =
		envelope.verdict === "split"
			? "Conflict: show both sides and ask once more or ask the user. Do not silently change course.\n\n"
			: "";
	return `${splitHint}${MSG_CONSULT_LOG_HINT}\n\n${JSON.stringify(payload, null, 2)}`;
}

export function buildConsultToolResult(opts: {
	envelope: ConsultEnvelope;
	trigger: ConsultTrigger;
	models: string[];
	outcome?: ConsultOutcome;
	usage?: UsageSnapshot;
}): AgentToolResult<ConsultDetails> {
	const outcome = opts.outcome ?? (opts.envelope.error ? "failed" : "completed");
	const details: ConsultDetails = {
		trigger: opts.trigger,
		models: opts.models,
		envelope: opts.envelope,
		outcome,
		...(opts.envelope.error ? { errorMessage: opts.envelope.error } : {}),
	};
	return {
		content: [{ type: "text", text: formatConsultResultText(opts.envelope, outcome) }],
		details,
		...(hasUsage(opts.usage) ? { usage: opts.usage } : {}),
	};
}

export function sumUsage(raw: ConsultRaw[]): UsageSnapshot | undefined {
	let total: UsageSnapshot | undefined;
	for (const entry of raw) total = addUsage(total, entry.usage);
	return total;
}
