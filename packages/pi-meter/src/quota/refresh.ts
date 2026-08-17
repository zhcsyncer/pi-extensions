import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchClaudeQuota } from "./adapters/claude.ts";
import { fetchCodexQuota } from "./adapters/codex.ts";
import { fetchOllamaQuota } from "./adapters/ollama.ts";
import { fetchSuperGrokQuota } from "./adapters/supergrok.ts";
import { decideRefresh, markAttempt, putSnapshot, withStaleFlags } from "./policy.ts";
import { sanitizeQuotaError } from "./sanitize.ts";
import { loadQuotaStore, saveQuotaStore } from "./store.ts";
import type { QuotaProviderId, QuotaSnapshot, QuotaStoreFile } from "./types.ts";
import { QUOTA_PROVIDERS, quotaProviderTitle } from "./types.ts";

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

export function preferredProvider(model: { provider?: string } | undefined): QuotaProviderId | undefined {
	switch (model?.provider) {
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
	providers?: readonly QuotaProviderId[];
	ttlMs?: number;
	minIntervalMs?: number;
	fetchers?: Partial<Record<QuotaProviderId, QuotaFetcher>>;
	now?: number;
}

export async function refreshQuotaSnapshots(
	ctx: Pick<ExtensionContext, "hasUI" | "modelRegistry">,
	agentDir: string,
	options: RefreshOptions = {},
): Promise<{ store: QuotaStoreFile; fetched: QuotaProviderId[] }> {
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

	const targets = options.providers ?? QUOTA_PROVIDERS;
	const fetched: QuotaProviderId[] = [];
	for (const provider of targets) {
		const decision = decideRefresh(store, provider, now, {
			force: options.force,
			ttlMs: store.ttlMs,
			minIntervalMs: store.minIntervalMs,
		});
		if (!decision.refresh) continue;
		store = markAttempt(store, provider, now);
		await saveQuotaStore(store, agentDir);
		const fetcher = options.fetchers?.[provider] ?? DEFAULT_FETCHERS[provider];
		try {
			store = putSnapshot(store, await fetcher(ctx, now));
		} catch (error) {
			store = putSnapshot(store, {
				provider,
				title: quotaProviderTitle(provider),
				windows: [],
				fetchedAt: now,
				ok: false,
				error: sanitizeQuotaError(error),
			});
		}
		fetched.push(provider);
	}
	if (fetched.length > 0) await saveQuotaStore(store, agentDir);
	return { store: withStaleFlags(store, now), fetched };
}
