import { isUnsignedQuotaSnapshot, shouldBypassQuotaMinInterval } from "./auth.ts";
import type { QuotaProviderId, QuotaRefreshDecision, QuotaSnapshot, QuotaStoreFile, QuotaWindow } from "./types.ts";
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
	provider: QuotaProviderId,
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

export function markAttempt(store: QuotaStoreFile, provider: QuotaProviderId, now: number): QuotaStoreFile {
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
	for (const [id, snapshot] of Object.entries(store.providers) as Array<[QuotaProviderId, QuotaSnapshot]>) {
		providers[id] = { ...snapshot, stale: !isSnapshotFresh(snapshot, now, ttlMs) };
	}
	return { ...store, providers };
}

export interface QuotaWindowView {
	provider: QuotaProviderId;
	window: QuotaWindow;
	stale: boolean;
}

export interface ChromeQuotaHint {
	label: string;
	value: string;
}

export function chromeWindow(store: QuotaStoreFile, preferred?: QuotaProviderId): QuotaWindowView | undefined {
	if (!preferred) return undefined;
	const snapshot = store.providers[preferred];
	if (snapshot?.ok && snapshot.primary) {
		return {
			provider: preferred,
			window: snapshot.primary,
			stale: snapshot.stale === true,
		};
	}
	return undefined;
}

export function resolveChromeQuota(
	store: QuotaStoreFile | undefined,
	preferred: QuotaProviderId | undefined,
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
		return {
			view: {
				provider: preferred,
				window: snapshot.primary,
				stale: snapshot.stale === true,
			},
		};
	}
	// Live auth.json wins. A leftover unsigned snapshot after /login is "unavailable",
	// not "not signed in".
	if (options.signedIn !== true && isUnsignedQuotaSnapshot(snapshot)) {
		return { hint: { label: brand, value: "not signed in" } };
	}
	return { hint: { label: brand, value: "unavailable" } };
}
