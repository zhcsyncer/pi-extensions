import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../fs.ts";
import { resolveOAuthAccess } from "../auth.ts";
import { sanitizeQuotaError } from "../sanitize.ts";
import type { QuotaSnapshot, QuotaWindow } from "../types.ts";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function windowName(seconds: unknown): string {
	if (typeof seconds !== "number" || seconds <= 0) return "Window";
	if (seconds >= 604800 * 0.9) return "Week";
	if (seconds >= 86400) return `${Math.round(seconds / 86400)}d`;
	return `${Math.round(seconds / 3600)}h`;
}

function resetsAt(window: Record<string, unknown>, now: number): string | undefined {
	if (typeof window.reset_after_seconds === "number") return new Date(now + window.reset_after_seconds * 1000).toISOString();
	if (typeof window.reset_at === "number") return new Date(window.reset_at * 1000).toISOString();
	return undefined;
}

function fromRateWindow(id: string, label: string, value: unknown, now: number): QuotaWindow | undefined {
	if (!isRecord(value) || typeof value.used_percent !== "number") return undefined;
	return {
		id,
		label,
		usedPercent: value.used_percent,
		...(resetsAt(value, now) ? { resetsAt: resetsAt(value, now) } : {}),
	};
}

function collectRateWindows(prefix: string, details: unknown, now: number): QuotaWindow[] {
	if (!isRecord(details)) return [];
	const rows: QuotaWindow[] = [];
	const primary = fromRateWindow(
		`${prefix}-primary`,
		`${windowName(details.primary_window && isRecord(details.primary_window) ? details.primary_window.limit_window_seconds : undefined)} limit`,
		details.primary_window,
		now,
	);
	const secondary = fromRateWindow(
		`${prefix}-secondary`,
		windowName(details.secondary_window && isRecord(details.secondary_window) ? details.secondary_window.limit_window_seconds : undefined) === "Week"
			? "Week limit"
			: `${windowName(details.secondary_window && isRecord(details.secondary_window) ? details.secondary_window.limit_window_seconds : undefined)} limit`,
		details.secondary_window,
		now,
	);
	if (primary) rows.push(primary);
	if (secondary) rows.push(secondary);
	return rows;
}

export function parseCodexUsage(payload: unknown, fetchedAt: number): QuotaSnapshot {
	if (!isRecord(payload)) {
		return { provider: "codex", title: "OpenAI Codex", windows: [], fetchedAt, ok: false, error: "unexpected response" };
	}
	const windows = collectRateWindows("main", payload.rate_limit, fetchedAt);
	if (Array.isArray(payload.additional_rate_limits)) {
		for (const extra of payload.additional_rate_limits) {
			if (!isRecord(extra) || typeof extra.limit_name !== "string") continue;
			for (const window of collectRateWindows(extra.limit_name, extra.rate_limit, fetchedAt)) {
				windows.push({ ...window, label: `${extra.limit_name} (${window.label})` });
			}
		}
	}
	if (isRecord(payload.credits) && (payload.credits.unlimited || (payload.credits.has_credits && payload.credits.balance != null))) {
		windows.push({
			id: "credits",
			label: "Credits",
			usedPercent: 0,
			note: payload.credits.unlimited ? "unlimited" : `balance ${String(payload.credits.balance)}`,
		});
	}
	const title = typeof payload.plan_type === "string" && payload.plan_type
		? `OpenAI Codex (${payload.plan_type})`
		: "OpenAI Codex";
	return {
		provider: "codex",
		title,
		primary: windows[0],
		windows,
		fetchedAt,
		ok: true,
	};
}

export async function fetchCodexQuota(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	fetchedAt = Date.now(),
	fetchImpl: typeof fetch = fetch,
): Promise<QuotaSnapshot> {
	const auth = await resolveOAuthAccess(ctx, "openai-codex");
	if (!auth.ok) {
		return { provider: "codex", title: "OpenAI Codex", windows: [], fetchedAt, ok: false, error: auth.error };
	}
	if (!auth.access.accountId) {
		return { provider: "codex", title: "OpenAI Codex", windows: [], fetchedAt, ok: false, error: "missing ChatGPT account id — run /login" };
	}
	try {
		const response = await fetchImpl(CODEX_USAGE_URL, {
			headers: {
				Authorization: `Bearer ${auth.access.accessToken}`,
				"ChatGPT-Account-Id": auth.access.accountId,
				Accept: "application/json",
			},
		});
		if (!response.ok) {
			return { provider: "codex", title: "OpenAI Codex", windows: [], fetchedAt, ok: false, error: `HTTP ${response.status}` };
		}
		return parseCodexUsage(await response.json(), fetchedAt);
	} catch (error) {
		return { provider: "codex", title: "OpenAI Codex", windows: [], fetchedAt, ok: false, error: sanitizeQuotaError(error) };
	}
}
