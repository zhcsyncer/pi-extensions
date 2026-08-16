import type { QuotaProviderId, QuotaRefreshDecision, QuotaSnapshot, QuotaStoreFile } from "./types.ts";
import { QUOTA_MIN_INTERVAL_MS, QUOTA_TTL_MS } from "./types.ts";

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
	if (!snapshot) return false;
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
	if (options.force) {
		if (lastAttempt !== undefined && now - lastAttempt < minIntervalMs) {
			return { provider, refresh: false, reason: "min-interval" };
		}
		return { provider, refresh: true, reason: "forced" };
	}
	if (isSnapshotFresh(snapshot, now, ttlMs)) {
		return { provider, refresh: false, reason: "fresh" };
	}
	if (lastAttempt !== undefined && now - lastAttempt < minIntervalMs) {
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

export function putSnapshot(store: QuotaStoreFile, snapshot: QuotaSnapshot): QuotaStoreFile {
	return {
		...store,
		providers: { ...store.providers, [snapshot.provider]: snapshot },
		lastAttemptAt: { ...store.lastAttemptAt, [snapshot.provider]: snapshot.fetchedAt },
	};
}

export function withStaleFlags(store: QuotaStoreFile, now: number, ttlMs = store.ttlMs ?? QUOTA_TTL_MS): QuotaStoreFile {
	const providers: QuotaStoreFile["providers"] = {};
	for (const [id, snapshot] of Object.entries(store.providers) as Array<[QuotaProviderId, QuotaSnapshot]>) {
		providers[id] = { ...snapshot, stale: !isSnapshotFresh(snapshot, now, ttlMs) };
	}
	return { ...store, providers };
}

export function chromeWindow(store: QuotaStoreFile, preferred?: QuotaProviderId): QuotaWindowView | undefined {
	const order: QuotaProviderId[] = preferred
		? [preferred, ...(["claude", "codex", "supergrok"] as const).filter((id) => id !== preferred)]
		: ["claude", "codex", "supergrok"];
	for (const id of order) {
		const snapshot = store.providers[id];
		if (snapshot?.ok && snapshot.primary) {
			return {
				provider: id,
				window: snapshot.primary,
				stale: snapshot.stale === true,
			};
		}
	}
	return undefined;
}

export interface QuotaWindowView {
	provider: QuotaProviderId;
	window: import("./types.ts").QuotaWindow;
	stale: boolean;
}
