import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchClaudeQuota } from "./adapters/claude.ts";
import { fetchCodexQuota } from "./adapters/codex.ts";
import { fetchOllamaQuota } from "./adapters/ollama.ts";
import { fetchSuperGrokQuota } from "./adapters/supergrok.ts";
import { hasStoredQuotaCredential, isUnsignedQuotaSnapshot, unsignedQuotaError } from "./auth.ts";
import { getQuotaAdapter, listedQuotaSourceIds, listQuotaAdapters, quotaSourceTitle } from "./guest.ts";
import { decideRefresh, markAttempt, putSnapshot, withStaleFlags } from "./policy.ts";
import { sanitizeQuotaError } from "./sanitize.ts";
import { loadQuotaStore, saveQuotaStore } from "./store.ts";
import type { QuotaProviderId, QuotaSnapshot, QuotaSourceId, QuotaStoreFile } from "./types.ts";
import { isBuiltinQuotaProvider } from "./types.ts";

export type QuotaFetcher = (
	ctx: Pick<ExtensionContext, "modelRegistry">,
	fetchedAt?: number,
) => Promise<QuotaSnapshot>;

export const DEFAULT_FETCHERS: Record<QuotaProviderId, QuotaFetcher> = {
	claude: fetchClaudeQuota,
	codex: fetchCodexQuota,
	supergrok: fetchSuperGrokQuota,
	ollama: fetchOllamaQuota,
};

export function preferredProvider(model: { provider?: string } | undefined): QuotaSourceId | undefined {
	const provider = model?.provider;
	if (typeof provider !== "string" || !provider) return undefined;
	for (const adapter of listQuotaAdapters()) {
		try {
			if (adapter.matchProvider(provider)) return adapter.id;
		} catch {
			// A broken guest matcher must not take down the footer.
		}
	}
	switch (provider) {
		case "anthropic":
			return "claude";
		case "openai-codex":
			return "codex";
		case "xai":
			return "supergrok";
		case "ollama-cloud":
			return "ollama";
		default:
			return undefined;
	}
}

export interface RefreshOptions {
	force?: boolean;
	providers?: readonly QuotaSourceId[];
	ttlMs?: number;
	minIntervalMs?: number;
	fetchers?: Partial<Record<QuotaSourceId, QuotaFetcher>>;
	hasCredential?: (provider: QuotaSourceId) => boolean;
	now?: number;
}

function unsignedSnapshot(provider: QuotaSourceId, fetchedAt: number): QuotaSnapshot {
	return {
		provider,
		title: quotaSourceTitle(provider),
		windows: [],
		fetchedAt,
		ok: false,
		error: unsignedQuotaError(provider),
	};
}

function resolveFetcher(
	provider: QuotaSourceId,
	fetchers?: Partial<Record<QuotaSourceId, QuotaFetcher>>,
): QuotaFetcher | undefined {
	if (fetchers?.[provider]) return fetchers[provider];
	const guest = getQuotaAdapter(provider);
	if (guest) return (ctx, fetchedAt) => guest.fetch(ctx, fetchedAt);
	return DEFAULT_FETCHERS[provider as QuotaProviderId];
}

export async function refreshQuotaSnapshots(
	ctx: Pick<ExtensionContext, "hasUI" | "modelRegistry">,
	agentDir: string,
	options: RefreshOptions = {},
): Promise<{ store: QuotaStoreFile; fetched: QuotaSourceId[] }> {
	const now = options.now ?? Date.now();
	let store = await loadQuotaStore(agentDir, {
		ttlMs: options.ttlMs ?? 60_000,
		minIntervalMs: options.minIntervalMs ?? 30_000,
	});
	if (options.ttlMs) store = { ...store, ttlMs: options.ttlMs };
	if (options.minIntervalMs) store = { ...store, minIntervalMs: options.minIntervalMs };
	if (!ctx.hasUI) {
		return { store: withStaleFlags(store, now), fetched: [] };
	}

	const targets = options.providers ?? listedQuotaSourceIds();
	const fetched: QuotaSourceId[] = [];
	const hasCredential = options.hasCredential ?? hasStoredQuotaCredential;
	let dirty = false;
	for (const provider of targets) {
		const decision = decideRefresh(store, provider, now, {
			force: options.force,
			ttlMs: store.ttlMs,
			minIntervalMs: store.minIntervalMs,
		});
		if (!decision.refresh) continue;
		const guest = getQuotaAdapter(provider);
		if (!guest && isBuiltinQuotaProvider(provider) && !hasCredential(provider)) {
			if (!isUnsignedQuotaSnapshot(store.providers[provider])) {
				store = putSnapshot(store, unsignedSnapshot(provider, now), { recordAttempt: false });
				dirty = true;
			}
			continue;
		}
		const fetcher = resolveFetcher(provider, options.fetchers);
		if (!fetcher) continue;
		store = markAttempt(store, provider, now);
		await saveQuotaStore(store, agentDir);
		try {
			const snapshot = await fetcher(ctx, now);
			store = putSnapshot(store, { ...snapshot, provider });
		} catch (error) {
			store = putSnapshot(store, {
				provider,
				title: quotaSourceTitle(provider),
				windows: [],
				fetchedAt: now,
				ok: false,
				error: sanitizeQuotaError(error),
			});
		}
		fetched.push(provider);
		dirty = true;
	}
	if (dirty) await saveQuotaStore(store, agentDir);
	return { store: withStaleFlags(store, now), fetched };
}
