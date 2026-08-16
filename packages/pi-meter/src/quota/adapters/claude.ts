import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../fs.ts";
import { resolveOAuthAccess } from "../auth.ts";
import { sanitizeQuotaError } from "../sanitize.ts";
import type { QuotaSnapshot, QuotaWindow } from "../types.ts";

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

function parseResetsAt(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000).toISOString();
	if (typeof value === "string") {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
	}
	return undefined;
}

function windowFromUtilization(id: string, label: string, value: unknown): QuotaWindow | undefined {
	if (!isRecord(value) || typeof value.utilization !== "number") return undefined;
	return {
		id,
		label,
		usedPercent: value.utilization,
		...(parseResetsAt(value.resets_at) ? { resetsAt: parseResetsAt(value.resets_at) } : {}),
	};
}

function unifiedLabel(kind: string, scope: unknown): string {
	if (kind === "session") return "Session (5h)";
	if (kind === "weekly_all") return "Week (all models)";
	if (kind === "weekly_scoped") {
		const model = isRecord(scope) && isRecord(scope.model) ? scope.model : undefined;
		const name = typeof model?.display_name === "string" ? model.display_name : typeof model?.id === "string" ? model.id : "scoped";
		return `Week (${name})`;
	}
	return kind;
}

function extraNote(extra: Record<string, unknown>): string | undefined {
	const decimals = typeof extra.decimal_places === "number" ? extra.decimal_places : 2;
	const currency = typeof extra.currency === "string" ? extra.currency : undefined;
	const format = (amount: number) => {
		const value = amount / 10 ** decimals;
		if (currency) {
			try {
				return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
			} catch {
				// fall through
			}
		}
		return value.toFixed(decimals);
	};
	const used = typeof extra.used_credits === "number" ? format(extra.used_credits) : undefined;
	const limit = typeof extra.monthly_limit === "number" ? format(extra.monthly_limit) : undefined;
	if (used && limit) return `${used} of ${limit}`;
	return used;
}

export function parseClaudeUsage(payload: unknown, fetchedAt: number): QuotaSnapshot {
	if (!isRecord(payload)) {
		return { provider: "claude", title: "Claude", windows: [], fetchedAt, ok: false, error: "unexpected response" };
	}
	const windows: QuotaWindow[] = [];
	if (Array.isArray(payload.limits)) {
		for (const limit of payload.limits) {
			if (!isRecord(limit) || typeof limit.kind !== "string" || typeof limit.percent !== "number") continue;
			windows.push({
				id: typeof limit.scope === "object" ? `${limit.kind}:${JSON.stringify(limit.scope)}` : limit.kind,
				label: unifiedLabel(limit.kind, limit.scope),
				usedPercent: limit.percent,
				...(parseResetsAt(limit.resets_at) ? { resetsAt: parseResetsAt(limit.resets_at) } : {}),
			});
		}
	} else {
		const mapped = [
			windowFromUtilization("session", "Session (5h)", payload.five_hour),
			windowFromUtilization("week", "Week (all models)", payload.seven_day),
			windowFromUtilization("week-opus", "Week (Opus)", payload.seven_day_opus),
			windowFromUtilization("week-sonnet", "Week (Sonnet)", payload.seven_day_sonnet),
		];
		for (const window of mapped) if (window) windows.push(window);
	}
	if (isRecord(payload.extra_usage)) {
		const extra = payload.extra_usage;
		if (typeof extra.utilization === "number") {
			windows.push({
				id: "extra",
				label: "Extra usage",
				usedPercent: extra.utilization,
				...(extraNote(extra) ? { note: extraNote(extra) } : {}),
			});
		} else if (extra.is_enabled === false) {
			windows.push({
				id: "extra",
				label: "Extra usage",
				usedPercent: 0,
				note: "disabled",
			});
		}
	}
	const primary = windows.find((window) => window.id === "session" || window.label.startsWith("Session")) ?? windows[0];
	return {
		provider: "claude",
		title: "Claude",
		primary,
		windows,
		fetchedAt,
		ok: true,
	};
}

export async function fetchClaudeQuota(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	fetchedAt = Date.now(),
	fetchImpl: typeof fetch = fetch,
): Promise<QuotaSnapshot> {
	const auth = await resolveOAuthAccess(ctx, "anthropic");
	if (!auth.ok) {
		return { provider: "claude", title: "Claude", windows: [], fetchedAt, ok: false, error: auth.error };
	}
	try {
		const response = await fetchImpl(ANTHROPIC_USAGE_URL, {
			headers: {
				Authorization: `Bearer ${auth.access.accessToken}`,
				"anthropic-beta": ANTHROPIC_OAUTH_BETA,
				Accept: "application/json",
			},
		});
		if (!response.ok) {
			return { provider: "claude", title: "Claude", windows: [], fetchedAt, ok: false, error: `HTTP ${response.status}` };
		}
		return parseClaudeUsage(await response.json(), fetchedAt);
	} catch (error) {
		return { provider: "claude", title: "Claude", windows: [], fetchedAt, ok: false, error: sanitizeQuotaError(error) };
	}
}
