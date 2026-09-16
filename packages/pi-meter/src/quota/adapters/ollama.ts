import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../fs.ts";
import { resolveApiKeyAccess } from "../auth.ts";
import { sanitizeQuotaError } from "../sanitize.ts";
import type { QuotaModelUsage, QuotaSnapshot, QuotaWindow } from "../types.ts";

export const OLLAMA_USAGE_URL = "https://ollama.com/api/usage";

/** Cap what is persisted in quota.json; the dashboard only ever shows five. */
const MONTHLY_MODELS_STORED = 10;

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** API reports a fraction (0.98 = 98%). Also accept a defensive percent-style value. */
function usedPercent(value: unknown): number | undefined {
	const raw = finiteNumber(value);
	if (raw === undefined || raw < 0 || raw > 100) return undefined;
	const percent = raw <= 1 ? raw * 100 : raw;
	return Math.round(percent * 1000) / 1000;
}

function windowFromLimits(
	id: string,
	label: string,
	value: unknown,
	aliases: readonly string[],
): QuotaWindow | undefined {
	if (!isRecord(value)) return undefined;
	const percent = usedPercent(value.usage)
		?? usedPercent(value.used_percent)
		?? usedPercent(value.usedPercent)
		?? usedPercent(value.used_percentage)
		?? usedPercent(value.utilization);
	if (percent === undefined) {
		for (const alias of aliases) {
			const nested = usedPercent(value[alias]);
			if (nested !== undefined) {
				return { id, label, usedPercent: nested };
			}
		}
		return undefined;
	}
	return { id, label, usedPercent: percent };
}

function modelName(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requestCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The documented shape is an array of `{ name, request_count }`; community
 * reports also see an object keyed by model name. Tolerate both.
 */
function monthlyModelRequests(models: unknown): { name: string; count: number }[] {
	const requests: { name: string; count: number }[] = [];
	if (Array.isArray(models)) {
		for (const item of models) {
			if (!isRecord(item)) continue;
			const name = modelName(item.name);
			const count = requestCount(item.request_count);
			if (name !== undefined && count !== undefined) requests.push({ name, count });
		}
	} else if (isRecord(models)) {
		for (const [name, item] of Object.entries(models)) {
			const count = requestCount(isRecord(item) ? item.request_count : undefined);
			if (count === undefined || !name.trim()) continue;
			requests.push({ name: name.trim(), count });
		}
	}
	return requests.sort((a, b) => b.count - a.count);
}

/**
 * The trailing activity period is a stats range, not a quota reset, so it only
 * annotates spend.
 */
function activityCost(activity: Record<string, unknown> | undefined): number | undefined {
	const period = isRecord(activity?.period) ? activity.period : undefined;
	if (period?.type !== "last_4_weeks") return undefined;
	const raw = activity?.cost;
	const cost = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : Number.NaN;
	return Number.isFinite(cost) ? cost : undefined;
}

/** Credit-based plans report only the monthly window; annotate recent spend. */
function monthlySpendNote(activity: Record<string, unknown> | undefined): string | undefined {
	const cost = activityCost(activity);
	return cost !== undefined && cost > 0 ? `$${cost.toFixed(2)} last 4 weeks` : undefined;
}

/** Persisted per-model usage for the monthly window, capped to limit quota.json growth. */
function monthlyModelUsage(models: unknown): QuotaModelUsage[] {
	return monthlyModelRequests(models)
		.slice(0, MONTHLY_MODELS_STORED)
		.map((entry) => ({ name: entry.name, requestCount: entry.count }));
}

function extraNote(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	if (value.unlimited === true) return "unlimited";
	const remaining = finiteNumber(value.remaining)
		?? finiteNumber(value.balance)
		?? finiteNumber(value.credits);
	if (remaining === undefined) return undefined;
	return `balance ${remaining}`;
}

function planName(payload: Record<string, unknown>): string | undefined {
	for (const value of [payload.plan, payload.plan_type, payload.planType]) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	const activity = isRecord(payload.activity) ? payload.activity : undefined;
	if (typeof activity?.plan === "string" && activity.plan.trim()) return activity.plan.trim();
	return undefined;
}

export function parseOllamaUsage(payload: unknown, fetchedAt: number): QuotaSnapshot {
	const failed = (error: string): QuotaSnapshot => ({
		provider: "ollama",
		title: "Ollama Cloud",
		windows: [],
		fetchedAt,
		ok: false,
		error,
	});
	if (!isRecord(payload)) return failed("unexpected response");
	const limits = isRecord(payload.limits) ? payload.limits : payload;
	const session = windowFromLimits("session", "Session (5h)", limits.session, ["used_percentage", "percent"]);
	const weekly = windowFromLimits("weekly", "Weekly (7d)", limits.weekly, ["used_percentage", "percent"]);
	const monthly = windowFromLimits("monthly", "Monthly (30d)", limits.monthly, ["used_percentage", "percent"]);
	if (!session && !weekly && !monthly) return failed("missing usage windows");

	if (monthly) {
		const note = monthlySpendNote(isRecord(payload.activity) ? payload.activity : undefined);
		if (note !== undefined) monthly.note = note;
		const models = monthlyModelUsage(isRecord(limits.monthly) ? limits.monthly.models : undefined);
		if (models.length > 0) monthly.models = models;
	}

	const extraSource = limits.extra ?? limits.extra_usage ?? payload.extra ?? payload.extra_usage;
	const extra = extraNote(extraSource);
	const windows: QuotaWindow[] = [];
	if (session) windows.push(session);
	if (weekly) windows.push(weekly);
	if (monthly) windows.push(monthly);
	if (extra) windows.push({ id: "extra", label: "Extra usage", usedPercent: 0, note: extra });
	const plan = planName(payload);
	return {
		provider: "ollama",
		title: plan ? `Ollama Cloud (${plan})` : "Ollama Cloud",
		primary: monthly ?? session ?? weekly,
		windows,
		fetchedAt,
		ok: true,
	};
}

export async function fetchOllamaQuota(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	fetchedAt = Date.now(),
	fetchImpl: typeof fetch = fetch,
): Promise<QuotaSnapshot> {
	const failed = (error: string): QuotaSnapshot => ({
		provider: "ollama",
		title: "Ollama Cloud",
		windows: [],
		fetchedAt,
		ok: false,
		error,
	});
	const auth = await resolveApiKeyAccess(ctx, "ollama-cloud");
	if (!auth.ok) return failed(auth.error);
	try {
		const response = await fetchImpl(OLLAMA_USAGE_URL, {
			headers: {
				Authorization: `Bearer ${auth.apiKey}`,
				Accept: "application/json",
			},
		});
		if (!response.ok) return failed(`HTTP ${response.status}`);
		return parseOllamaUsage(await response.json(), fetchedAt);
	} catch (error) {
		return failed(sanitizeQuotaError(error));
	}
}
