import { withStaleFlags } from "../quota/policy.ts";
import { loadQuotaStore } from "../quota/store.ts";
import type { QuotaStoreFile } from "../quota/types.ts";

/** Idle TUI sessions reread the shared files this often. No subscription APIs. */
export const STATUS_CACHE_POLL_MS = 30_000;

export async function readLocalQuotaCache(
	agentDir: string,
	defaults: { ttlMs: number; minIntervalMs: number },
	now = Date.now(),
): Promise<QuotaStoreFile> {
	const store = await loadQuotaStore(agentDir, defaults);
	return withStaleFlags(store, now, defaults.ttlMs);
}
