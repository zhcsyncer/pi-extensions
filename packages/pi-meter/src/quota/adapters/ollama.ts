import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../fs.ts";
import { resolveApiKeyAccess } from "../auth.ts";
import { sanitizeQuotaError } from "../sanitize.ts";
import type { QuotaSnapshot, QuotaWindow } from "../types.ts";

export const OLLAMA_USAGE_URL = "https://ollama.com/api/usage";

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
	if (!session || !weekly) return failed("missing session or weekly usage");
	const extraSource = limits.extra ?? limits.extra_usage ?? payload.extra ?? payload.extra_usage;
	const extra = extraNote(extraSource);
	const windows: QuotaWindow[] = [session, weekly];
	if (extra) windows.push({ id: "extra", label: "Extra usage", usedPercent: 0, note: extra });
	const plan = planName(payload);
	return {
		provider: "ollama",
		title: plan ? `Ollama Cloud (${plan})` : "Ollama Cloud",
		primary: session,
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
