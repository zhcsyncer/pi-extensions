import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../fs.ts";
import { resolveOAuthAccess } from "../auth.ts";
import { sanitizeQuotaError } from "../sanitize.ts";
import type { QuotaResetCredit, QuotaResets, QuotaSnapshot, QuotaWindow } from "../types.ts";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
export const CODEX_RESET_CREDITS_TIMEOUT_MS = 5_000;

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

function parseAvailableCount(value: unknown): number | undefined {
	if (!isRecord(value) || typeof value.available_count !== "number" || !Number.isFinite(value.available_count)) {
		return undefined;
	}
	return Math.max(0, Math.floor(value.available_count));
}

function parseResetItems(credits: unknown, now: number): QuotaResetCredit[] {
	if (!Array.isArray(credits)) return [];
	const items: QuotaResetCredit[] = [];
	for (const credit of credits) {
		if (!isRecord(credit)) continue;
		if (credit.status !== undefined && credit.status !== "available") continue;
		if (typeof credit.expires_at !== "string") continue;
		const expires = new Date(credit.expires_at);
		if (Number.isNaN(expires.getTime()) || expires.getTime() <= now) continue;
		items.push({
			expiresAt: expires.toISOString(),
			...(typeof credit.title === "string" && credit.title.trim() ? { title: credit.title.trim() } : {}),
		});
	}
	items.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
	return items;
}

function parseResetsFromUsage(payload: Record<string, unknown>): QuotaResets | undefined {
	const availableCount = parseAvailableCount(payload.rate_limit_reset_credits);
	if (availableCount === undefined || availableCount <= 0) return undefined;
	return { availableCount };
}

function parseResetCreditsPayload(payload: unknown, now: number): QuotaResets | undefined {
	const availableCount = parseAvailableCount(payload);
	if (availableCount === undefined) return undefined;
	if (availableCount <= 0) return { availableCount: 0 };
	const items = parseResetItems(isRecord(payload) ? payload.credits : undefined, now);
	return {
		availableCount,
		...(items.length > 0 ? { items } : {}),
	};
}

function failedSnapshot(fetchedAt: number, error: string): QuotaSnapshot {
	return { provider: "codex", title: "OpenAI Codex", windows: [], fetchedAt, ok: false, error };
}

function applyResetCredits(snapshot: QuotaSnapshot, parsed: QuotaResets): QuotaSnapshot {
	if (parsed.availableCount <= 0) {
		const next = { ...snapshot };
		delete next.resets;
		return next;
	}
	return { ...snapshot, resets: parsed };
}

export function parseCodexUsage(payload: unknown, fetchedAt: number): QuotaSnapshot {
	if (!isRecord(payload)) {
		return failedSnapshot(fetchedAt, "unexpected response");
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
	const resets = parseResetsFromUsage(payload);
	return {
		provider: "codex",
		title,
		primary: windows[0],
		windows,
		fetchedAt,
		ok: true,
		...(resets ? { resets } : {}),
	};
}

function authHeaders(accessToken: string, accountId: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"ChatGPT-Account-Id": accountId,
		Accept: "application/json",
	};
}

async function mergeResetCredits(
	snapshot: QuotaSnapshot,
	headers: Record<string, string>,
	fetchedAt: number,
	fetchImpl: typeof fetch,
	timeoutMs: number,
): Promise<QuotaSnapshot> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
	try {
		const response = await fetchImpl(CODEX_RESET_CREDITS_URL, { headers, signal: controller.signal });
		if (!response.ok) return snapshot;
		const parsed = parseResetCreditsPayload(await response.json(), fetchedAt);
		if (!parsed) return snapshot;
		return applyResetCredits(snapshot, parsed);
	} catch {
		return snapshot;
	} finally {
		clearTimeout(timeout);
	}
}

export async function fetchCodexQuota(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	fetchedAt = Date.now(),
	fetchImpl: typeof fetch = fetch,
	resetDetailsTimeoutMs = CODEX_RESET_CREDITS_TIMEOUT_MS,
): Promise<QuotaSnapshot> {
	const auth = await resolveOAuthAccess(ctx, "openai-codex");
	if (!auth.ok) return failedSnapshot(fetchedAt, auth.error);
	if (!auth.access.accountId) {
		return failedSnapshot(fetchedAt, "missing ChatGPT account id — run /login");
	}
	const headers = authHeaders(auth.access.accessToken, auth.access.accountId);
	try {
		const response = await fetchImpl(CODEX_USAGE_URL, { headers });
		if (!response.ok) return failedSnapshot(fetchedAt, `HTTP ${response.status}`);
		const snapshot = parseCodexUsage(await response.json(), fetchedAt);
		if (!snapshot.ok || (snapshot.resets?.availableCount ?? 0) <= 0) return snapshot;
		return await mergeResetCredits(snapshot, headers, fetchedAt, fetchImpl, resetDetailsTimeoutMs);
	} catch (error) {
		return failedSnapshot(fetchedAt, sanitizeQuotaError(error));
	}
}
