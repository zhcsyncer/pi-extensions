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

const VERDICTS = new Set<ConsultVerdict>(["plan", "correction", "stop", "split"]);
const ADVISOR_VERDICTS = new Set<Exclude<ConsultVerdict, "split">>(["plan", "correction", "stop"]);

export function usageSnapshotFrom(usage: {
	input?: number;
	output?: number;
	totalTokens?: number;
	cost?: { total?: number };
} | undefined): UsageSnapshot | undefined {
	if (!usage) return undefined;
	return {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		totalTokens: usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0),
		cost: usage.cost?.total ?? 0,
	};
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
	const tagged = text.match(/\bverdict\s*[:=]\s*"?(plan|correction|stop)"?/i);
	if (tagged) {
		return { verdict: tagged[1].toLowerCase() as Exclude<ConsultVerdict, "split">, summary: text.trim() };
	}
	return { verdict: "plan", summary: text.trim() };
}

export interface AdvisorSuccess {
	ok: true;
	label: string;
	text: string;
	usage?: UsageSnapshot;
}

export interface AdvisorFailure {
	ok: false;
	label: string;
	error: string;
	usage?: UsageSnapshot;
}

export type AdvisorOutcome = AdvisorSuccess | AdvisorFailure;

function toRaw(outcome: AdvisorOutcome): ConsultRaw {
	return {
		model: outcome.label,
		text: outcome.ok ? outcome.text : outcome.error,
		...(outcome.usage ? { usage: outcome.usage } : {}),
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
		verdict: VERDICTS.has(opts.verdict) ? opts.verdict : "plan",
		summary: opts.summary,
		raw: opts.raw ?? [],
	};
	if (opts.conflicts && opts.conflicts.length > 0) envelope.conflicts = opts.conflicts;
	if (opts.error) envelope.error = opts.error;
	return envelope;
}

export function errorEnvelope(summary: string, error = summary, raw: ConsultRaw[] = []): ConsultEnvelope {
	return buildConsultEnvelope({ verdict: "plan", summary, error, raw });
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

	if (verdicts.size === 1) {
		const verdict = parsed[0].parsed.verdict;
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
	effort?: string;
}): AgentToolResult<ConsultDetails> {
	const outcome = opts.outcome ?? (opts.envelope.error ? "failed" : "completed");
	const details: ConsultDetails = {
		trigger: opts.trigger,
		models: opts.models,
		envelope: opts.envelope,
		outcome,
		...(opts.effort ? { effort: opts.effort } : {}),
		...(opts.envelope.error ? { errorMessage: opts.envelope.error } : {}),
	};
	return {
		content: [{ type: "text", text: formatConsultResultText(opts.envelope, outcome) }],
		details,
	};
}

export function sumUsage(raw: ConsultRaw[]): { tokensIn: number; tokensOut: number; costUsd: number } {
	let tokensIn = 0;
	let tokensOut = 0;
	let costUsd = 0;
	for (const entry of raw) {
		if (!entry.usage) continue;
		tokensIn += entry.usage.input;
		tokensOut += entry.usage.output;
		costUsd += entry.usage.cost;
	}
	return { tokensIn, tokensOut, costUsd };
}
