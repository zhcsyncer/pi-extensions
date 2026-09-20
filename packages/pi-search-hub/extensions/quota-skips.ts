/**
 * Quota skips and cached Tavily/Firecrawl usage.
 * Hosted backends skip as a whole; API keys skip per key.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NoticeSink } from "./diagnostics.js";
import { getQuotaSkipsPath } from "./paths.js";
import { timeoutSignal } from "./utils.js";

/** Codex primary windows are ~5h. Weekly caps still only retry a few times a day. */
export const HOSTED_QUOTA_SKIP_MS = 5 * 60 * 60 * 1000;
/** Exa / Parallel have no remaining API; skip an exhausted key for a day. */
export const KEY_QUOTA_SKIP_MS = 24 * 60 * 60 * 1000;
/** Usage snapshots are for /search-hub status; refresh on search only when stale. */
export const USAGE_TTL_MS = 15 * 60 * 1000;
export const USAGE_MIN_INTERVAL_MS = 60 * 1000;

export const USAGE_BACKENDS = new Set(["tavily", "firecrawl"]);

export interface KeyQuotaEntry {
	usage?: number;
	limit?: number;
	remaining?: number;
	skipUntil?: number;
	fetchedAt?: number;
	periodEnd?: number;
}

export interface BackendQuotaEntry {
	until?: number;
	fetchedAt?: number;
	lastAttemptAt?: number;
	keys?: Record<string, KeyQuotaEntry>;
}

export type QuotaState = Record<string, BackendQuotaEntry>;

const memory: QuotaState = {};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fingerprintKey(key: string): string {
	return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function isQuotaExhaustedError(error: unknown): boolean {
	const text = error instanceof Error ? error.message : String(error);
	if (/\b402\b/.test(text)) return true;
	return /usage[_ ]limit|usage_not_included|GoUsageLimitError|FreeUsageLimitError|Monthly usage limit|insufficient_quota|out of budget|quota exceeded/i.test(text);
}

export function nextMonthUtc(now: number): number {
	const date = new Date(now);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

export function formatLocalDateTime(at: number): string {
	const date = new Date(at);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseKeyEntry(value: unknown): KeyQuotaEntry | undefined {
	if (!isRecord(value)) return undefined;
	const entry: KeyQuotaEntry = {};
	for (const field of ["usage", "limit", "remaining", "skipUntil", "fetchedAt", "periodEnd"] as const) {
		if (typeof value[field] === "number" && Number.isFinite(value[field])) entry[field] = value[field];
	}
	return entry;
}

function parseBackendEntry(value: unknown): BackendQuotaEntry {
	if (typeof value === "number" && Number.isFinite(value)) return { until: value };
	if (!isRecord(value)) return {};
	const entry: BackendQuotaEntry = {};
	if (typeof value.until === "number" && Number.isFinite(value.until)) entry.until = value.until;
	if (typeof value.fetchedAt === "number" && Number.isFinite(value.fetchedAt)) entry.fetchedAt = value.fetchedAt;
	if (typeof value.lastAttemptAt === "number" && Number.isFinite(value.lastAttemptAt)) entry.lastAttemptAt = value.lastAttemptAt;
	if (isRecord(value.keys)) {
		const keys: Record<string, KeyQuotaEntry> = {};
		for (const [id, raw] of Object.entries(value.keys)) {
			const parsed = parseKeyEntry(raw);
			if (parsed) keys[id] = parsed;
		}
		if (Object.keys(keys).length > 0) entry.keys = keys;
	}
	return entry;
}

function parseState(value: unknown): QuotaState {
	if (!isRecord(value)) return {};
	const state: QuotaState = {};
	for (const [backend, raw] of Object.entries(value)) {
		state[backend] = parseBackendEntry(raw);
	}
	return state;
}

function readDisk(): QuotaState {
	const file = getQuotaSkipsPath();
	if (!existsSync(file)) return {};
	try {
		return parseState(JSON.parse(readFileSync(file, "utf8")) as unknown);
	} catch {
		return {};
	}
}

function writeDisk(state: QuotaState): void {
	const file = getQuotaSkipsPath();
	const directory = dirname(file);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		renameSync(temporary, file);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function mergedState(): QuotaState {
	const disk = readDisk();
	const next: QuotaState = { ...disk };
	for (const [backend, entry] of Object.entries(memory)) {
		next[backend] = {
			...disk[backend],
			...entry,
			keys: { ...disk[backend]?.keys, ...entry.keys },
		};
	}
	return next;
}

function persist(state: QuotaState): void {
	for (const name of Object.keys(memory)) delete memory[name];
	Object.assign(memory, state);
	try {
		writeDisk(state);
	} catch {
		// Same-process skip still holds.
	}
}

function prune(state: QuotaState, now: number): QuotaState {
	const next: QuotaState = {};
	for (const [backend, entry] of Object.entries(state)) {
		const keys: Record<string, KeyQuotaEntry> = {};
		for (const [id, key] of Object.entries(entry.keys ?? {})) {
			const skipUntil = key.skipUntil !== undefined && key.skipUntil <= now ? undefined : key.skipUntil;
			keys[id] = skipUntil === key.skipUntil ? key : { ...key, skipUntil };
			if (skipUntil === undefined) delete keys[id].skipUntil;
		}
		const until = entry.until !== undefined && entry.until <= now ? undefined : entry.until;
		const pruned: BackendQuotaEntry = { ...entry, until, keys: Object.keys(keys).length > 0 ? keys : undefined };
		if (until === undefined) delete pruned.until;
		next[backend] = pruned;
	}
	return next;
}

export function readQuotaState(): QuotaState {
	return prune(mergedState(), Date.now());
}

export function quotaSkipUntil(backend: string, now = Date.now()): number | undefined {
	const until = mergedState()[backend]?.until;
	if (until === undefined || until <= now) return undefined;
	return until;
}

export function keySkipUntil(backend: string, key: string, now = Date.now()): number | undefined {
	const until = mergedState()[backend]?.keys?.[fingerprintKey(key)]?.skipUntil;
	if (until === undefined || until <= now) return undefined;
	return until;
}

export function usableKeys(backend: string, keys: readonly string[], now = Date.now()): string[] {
	return keys.filter((key) => keySkipUntil(backend, key, now) === undefined);
}

export function latestKeySkipUntil(backend: string, keys: readonly string[], now = Date.now()): number | undefined {
	let latest: number | undefined;
	for (const key of keys) {
		const until = keySkipUntil(backend, key, now);
		if (until !== undefined && (latest === undefined || until > latest)) latest = until;
	}
	return latest;
}

export function markHostedQuotaSkip(backend: string, now = Date.now()): number {
	const until = now + HOSTED_QUOTA_SKIP_MS;
	const state = prune(mergedState(), now);
	state[backend] = { ...state[backend], until };
	persist(state);
	return until;
}

export function markKeyQuotaSkip(backend: string, key: string, until: number, now = Date.now()): number {
	const id = fingerprintKey(key);
	const state = prune(mergedState(), now);
	const current = state[backend] ?? {};
	state[backend] = {
		...current,
		keys: { ...current.keys, [id]: { ...current.keys?.[id], skipUntil: until } },
	};
	persist(state);
	return until;
}

export function skipUntilForUsageBackend(backend: string, key: string, now = Date.now()): number {
	if (backend === "tavily") return nextMonthUtc(now);
	if (backend === "firecrawl") {
		const periodEnd = mergedState()[backend]?.keys?.[fingerprintKey(key)]?.periodEnd;
		if (periodEnd !== undefined && periodEnd > now) return periodEnd;
		return nextMonthUtc(now);
	}
	return now + KEY_QUOTA_SKIP_MS;
}

export function filterQuotaSkipped(
	backends: readonly string[],
	onNotice?: NoticeSink,
	now = Date.now(),
	keysFor?: (backend: string) => readonly string[],
): string[] {
	const usable: string[] = [];
	for (const backend of backends) {
		const until = quotaSkipUntil(backend, now);
		if (until !== undefined) {
			onNotice?.(`Search Hub ${backend}: quota exhausted, skipping until ${formatLocalDateTime(until)}.`);
			continue;
		}
		const keys = keysFor?.(backend) ?? [];
		if (keys.length > 0 && usableKeys(backend, keys, now).length === 0) {
			const keyUntil = latestKeySkipUntil(backend, keys, now);
			onNotice?.(
				`Search Hub ${backend}: all keys skipped${keyUntil ? ` until ${formatLocalDateTime(keyUntil)}` : ""}.`,
			);
			continue;
		}
		usable.push(backend);
	}
	return usable;
}

export function parseTavilyUsage(body: unknown): { usage: number; limit: number; remaining: number } | undefined {
	if (!isRecord(body)) return undefined;
	const account = isRecord(body.account) ? body.account : {};
	const key = isRecord(body.key) ? body.key : {};
	const usage = numberOrUndefined(account.plan_usage) ?? numberOrUndefined(key.usage);
	const limit = numberOrUndefined(account.plan_limit) ?? numberOrUndefined(key.limit);
	if (usage === undefined || limit === undefined) return undefined;
	return { usage, limit, remaining: Math.max(0, limit - usage) };
}

export function parseFirecrawlUsage(body: unknown): { remaining: number; limit?: number; periodEnd?: number } | undefined {
	if (!isRecord(body)) return undefined;
	const data = isRecord(body.data) ? body.data : body;
	const remaining = numberOrUndefined(data.remainingCredits);
	if (remaining === undefined) return undefined;
	const limit = numberOrUndefined(data.planCredits);
	const periodEnd = typeof data.billingPeriodEnd === "string" ? Date.parse(data.billingPeriodEnd) : undefined;
	return {
		remaining,
		...(limit !== undefined ? { limit } : {}),
		...(periodEnd !== undefined && !Number.isNaN(periodEnd) ? { periodEnd } : {}),
	};
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function fetchJson(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
	const response = await fetch(url, { headers, signal: timeoutSignal(signal) });
	const text = await response.text();
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return text ? JSON.parse(text) as unknown : {};
}

async function fetchUsageForKey(backend: string, key: string, signal?: AbortSignal): Promise<KeyQuotaEntry> {
	const fetchedAt = Date.now();
	if (backend === "tavily") {
		const parsed = parseTavilyUsage(await fetchJson("https://api.tavily.com/usage", {
			Authorization: `Bearer ${key}`,
			Accept: "application/json",
		}, signal));
		if (!parsed) return { fetchedAt };
		return {
			fetchedAt,
			usage: parsed.usage,
			limit: parsed.limit,
			remaining: parsed.remaining,
			...(parsed.remaining <= 0 ? { skipUntil: nextMonthUtc(fetchedAt) } : {}),
		};
	}
	const parsed = parseFirecrawlUsage(await fetchJson("https://api.firecrawl.dev/v2/team/credit-usage", {
		Authorization: `Bearer ${key}`,
		Accept: "application/json",
	}, signal));
	if (!parsed) return { fetchedAt };
	return {
		fetchedAt,
		remaining: parsed.remaining,
		limit: parsed.limit,
		periodEnd: parsed.periodEnd,
		usage: parsed.limit !== undefined ? Math.max(0, parsed.limit - parsed.remaining) : undefined,
		...(parsed.remaining <= 0 ? { skipUntil: parsed.periodEnd && parsed.periodEnd > fetchedAt ? parsed.periodEnd : nextMonthUtc(fetchedAt) } : {}),
	};
}

export async function maybeRefreshKeyUsage(
	backend: string,
	keys: readonly string[],
	now = Date.now(),
	signal?: AbortSignal,
	force = false,
): Promise<"refreshed" | "fresh" | "min-interval" | "skipped"> {
	if (!USAGE_BACKENDS.has(backend) || keys.length === 0) return "skipped";
	const state = prune(mergedState(), now);
	const current = state[backend] ?? {};
	if (!force && current.fetchedAt !== undefined && now - current.fetchedAt < USAGE_TTL_MS) return "fresh";
	if (current.lastAttemptAt !== undefined && now - current.lastAttemptAt < USAGE_MIN_INTERVAL_MS) return "min-interval";
	state[backend] = { ...current, lastAttemptAt: now };
	persist(state);
	const nextKeys: Record<string, KeyQuotaEntry> = { ...current.keys };
	await Promise.all(keys.map(async (key) => {
		const id = fingerprintKey(key);
		try {
			nextKeys[id] = { ...nextKeys[id], ...await fetchUsageForKey(backend, key, signal) };
		} catch {
			nextKeys[id] = { ...nextKeys[id], fetchedAt: now };
		}
	}));
	const latest = prune(mergedState(), Date.now());
	latest[backend] = { ...latest[backend], fetchedAt: Date.now(), lastAttemptAt: now, keys: nextKeys };
	persist(latest);
	return "refreshed";
}

export function clearQuotaSkipsForTests(): void {
	for (const key of Object.keys(memory)) delete memory[key];
}
