import { isUnsignedQuotaSnapshot, shouldBypassQuotaMinInterval } from "./auth.ts";
import type { QuotaRefreshDecision, QuotaResets, QuotaSnapshot, QuotaSourceId, QuotaStoreFile, QuotaWindow } from "./types.ts";
import { QUOTA_MIN_INTERVAL_MS, QUOTA_TTL_MS, quotaProviderBrand } from "./types.ts";

export function emptyQuotaStore(now = Date.now(), ttlMs = QUOTA_TTL_MS, minIntervalMs = QUOTA_MIN_INTERVAL_MS): QuotaStoreFile {
	return {
		version: 1,
		ttlMs,
		minIntervalMs,
		providers: {},
		lastAttemptAt: {},
	};
}

export function remainingPercent(usedPercent: number): number {
	return Math.max(0, 100 - usedPercent);
}

export function isSnapshotFresh(snapshot: QuotaSnapshot | undefined, now: number, ttlMs = QUOTA_TTL_MS): boolean {
	if (!snapshot?.ok) return false;
	return now - snapshot.fetchedAt < ttlMs;
}

export function decideRefresh(
	store: QuotaStoreFile,
	provider: QuotaSourceId,
	now: number,
	options: { force?: boolean; ttlMs?: number; minIntervalMs?: number } = {},
): QuotaRefreshDecision {
	const ttlMs = options.ttlMs ?? store.ttlMs ?? QUOTA_TTL_MS;
	const minIntervalMs = options.minIntervalMs ?? store.minIntervalMs ?? QUOTA_MIN_INTERVAL_MS;
	const snapshot = store.providers[provider];
	const lastAttempt = store.lastAttemptAt[provider];
	const bypassMinInterval = shouldBypassQuotaMinInterval(snapshot);
	if (options.force) {
		if (!bypassMinInterval && lastAttempt !== undefined && now - lastAttempt < minIntervalMs) {
			return { provider, refresh: false, reason: "min-interval" };
		}
		return { provider, refresh: true, reason: "forced" };
	}
	if (isSnapshotFresh(snapshot, now, ttlMs)) {
		return { provider, refresh: false, reason: "fresh" };
	}
	if (!bypassMinInterval && lastAttempt !== undefined && now - lastAttempt < minIntervalMs) {
		return { provider, refresh: false, reason: "min-interval" };
	}
	return { provider, refresh: true, reason: snapshot ? "expired" : "missing" };
}

export function markAttempt(store: QuotaStoreFile, provider: QuotaSourceId, now: number): QuotaStoreFile {
	return {
		...store,
		lastAttemptAt: { ...store.lastAttemptAt, [provider]: now },
	};
}

export function putSnapshot(
	store: QuotaStoreFile,
	snapshot: QuotaSnapshot,
	options: { recordAttempt?: boolean } = {},
): QuotaStoreFile {
	return {
		...store,
		providers: { ...store.providers, [snapshot.provider]: snapshot },
		lastAttemptAt: options.recordAttempt === false
			? store.lastAttemptAt
			: { ...store.lastAttemptAt, [snapshot.provider]: snapshot.fetchedAt },
	};
}

export function withStaleFlags(store: QuotaStoreFile, now: number, ttlMs = store.ttlMs ?? QUOTA_TTL_MS): QuotaStoreFile {
	const providers: QuotaStoreFile["providers"] = {};
	for (const [id, snapshot] of Object.entries(store.providers) as Array<[QuotaSourceId, QuotaSnapshot]>) {
		providers[id] = { ...snapshot, stale: !isSnapshotFresh(snapshot, now, ttlMs) };
	}
	return { ...store, providers };
}

export interface QuotaWindowView {
	provider: QuotaSourceId;
	window: QuotaWindow;
	stale: boolean;
	fetchedAt?: number;
	resets?: QuotaResets;
}

function chromeView(preferred: QuotaSourceId, snapshot: QuotaSnapshot & { primary: QuotaWindow }): QuotaWindowView {
	return {
		provider: preferred,
		window: snapshot.primary,
		stale: snapshot.stale === true,
		fetchedAt: snapshot.fetchedAt,
		...(preferred === "codex" && snapshot.resets && snapshot.resets.availableCount > 0 ? { resets: snapshot.resets } : {}),
	};
}

export interface ChromeQuotaHint {
	label: string;
	value: string;
}

export function chromeWindow(store: QuotaStoreFile, preferred?: QuotaSourceId): QuotaWindowView | undefined {
	if (!preferred) return undefined;
	const snapshot = store.providers[preferred];
	if (snapshot?.ok && snapshot.primary) return chromeView(preferred, { ...snapshot, primary: snapshot.primary });
	return undefined;
}

export function resolveChromeQuota(
	store: QuotaStoreFile | undefined,
	preferred: QuotaSourceId | undefined,
	options: { modelProvider?: string; signedIn?: boolean } = {},
): { view?: QuotaWindowView; hint?: ChromeQuotaHint } {
	if (!preferred) {
		return {
			hint: {
				label: options.modelProvider?.trim() || "quota n/a",
				value: "no quota window",
			},
		};
	}
	const brand = quotaProviderBrand(preferred);
	if (options.signedIn === false) {
		return { hint: { label: brand, value: "not signed in" } };
	}
	const snapshot = store?.providers[preferred];
	if (snapshot?.ok && snapshot.primary) {
		return { view: chromeView(preferred, { ...snapshot, primary: snapshot.primary }) };
	}
	// Live auth.json wins. A leftover unsigned snapshot after /login is "unavailable",
	// not "not signed in".
	if (options.signedIn !== true && isUnsignedQuotaSnapshot(snapshot)) {
		return { hint: { label: brand, value: "not signed in" } };
	}
	return { hint: { label: brand, value: "unavailable" } };
}
