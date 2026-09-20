/**
 * Backend registry and dispatcher for pi-search-hub extension.
 */

import type { NoticeSink } from "../diagnostics.js";
import type { BackendRunner, BackendConfig, HostedSearchRuntime, SearchResult } from "../types.js";
import { MISSING_KEY_HELP, waitForCooldown, markCooldown } from "../utils.js";
import { resolveBackendKeys, withRotatedKeys } from "../credentials.js";
import { getConfig } from "../config.js";
import { reportEffectiveness } from "../effectiveness.js";
import { isQuotaExhaustedError, markHostedQuotaSkip } from "../quota-skips.js";

import { searchTavily } from "./tavily.js";
import { searchExa } from "./exa.js";
import { searchFirecrawl } from "./firecrawl.js";
import { searchParallel } from "./parallel.js";
import { searchHostedWebSearch } from "./hosted-search.js";

// ---------------------------------------------------------------------------
// Backend Registry
// ---------------------------------------------------------------------------

export const BACKEND_DEFS: Record<string, BackendRunner> = {
	exa: {
		needsKey: true,
		optionalKey: false,
		label: "Exa",
		setupLabel: "Exa (AI-native, 1000 free/mo)",
		search: async (query, numResults, { key, signal, onNotice }) => {
			const result = await searchExa(query, numResults, key!, signal, onNotice);
			return { results: result.results, warning: result.warning };
		},
	},
	tavily: {
		needsKey: true,
		optionalKey: false,
		label: "Tavily",
		setupLabel: "Tavily (AI search, 1000 free/mo)",
		search: async (query, numResults, { key, signal }) => {
			const result = await searchTavily(query, numResults, key!, signal);
			return { results: result.results };
		},
	},
	firecrawl: {
		needsKey: false,
		optionalKey: true,
		label: "Firecrawl",
		setupLabel: "Firecrawl (keyless: 1000 free credits/mo, optional key for more)",
		search: async (query, numResults, { key, signal }) => {
			const result = await searchFirecrawl(query, numResults, key, signal);
			return { results: result.results };
		},
	},
	parallel: {
		needsKey: true,
		optionalKey: false,
		label: "Parallel",
		setupLabel: "Parallel (official REST, API key required)",
		search: async (query, numResults, { key, signal }) => {
			const result = await searchParallel(query, numResults, key!, signal);
			return { results: result.results };
		},
	},
	"openai-codex": {
		providerAuth: "openai-codex",
		needsKey: false,
		optionalKey: false,
		label: "OpenAI Codex",
		setupLabel: "OpenAI Codex (Pi /login, hosted web search)",
		search: async (query, numResults, { signal, backendConfig, onNotice, modelRegistry }) => {
			const result = await searchHostedWebSearch(
				"openai-codex",
				query,
				numResults,
				modelRegistry,
				signal,
				backendConfig?.model,
				backendConfig?.timeout,
				onNotice,
			);
			return { results: result.results };
		},
	},
	xai: {
		providerAuth: "xai",
		needsKey: false,
		optionalKey: false,
		label: "Grok",
		setupLabel: "Grok (Pi /login, hosted web search)",
		search: async (query, numResults, { signal, backendConfig, onNotice, modelRegistry }) => {
			const result = await searchHostedWebSearch(
				"xai",
				query,
				numResults,
				modelRegistry,
				signal,
				backendConfig?.model,
				backendConfig?.timeout,
				onNotice,
			);
			return { results: result.results };
		},
	},
};

// ---------------------------------------------------------------------------
// Backend dispatcher
// ---------------------------------------------------------------------------

export interface BackendRuntime {
	onNotice?: NoticeSink;
	modelRegistry?: HostedSearchRuntime;
}

export async function runBackend(
	backend: string,
	query: string,
	numResults: number,
	signal?: AbortSignal,
	runtime?: BackendRuntime,
): Promise<SearchResult[]> {
	await waitForCooldown(backend);
	const def = BACKEND_DEFS[backend];
	if (!def) throw new Error(`Unknown backend: ${backend}`);
	const config = getConfig();
	const keys = def.providerAuth ? [] : resolveBackendKeys(backend, config, runtime?.onNotice);
	if (def.needsKey && keys.length === 0) {
		throw new Error(`${def.label} backend not configured. ${MISSING_KEY_HELP}`);
	}

	const bc = (config.backends as Record<string, BackendConfig | undefined>)?.[backend];
	const startTime = Date.now();
	const invoke = (key?: string) => def.search(query, numResults, {
		key,
		signal,
		backendConfig: bc,
		onNotice: runtime?.onNotice,
		modelRegistry: runtime?.modelRegistry,
	});
	try {
		const result = keys.length > 1
			? await withRotatedKeys(backend, keys, (key) => invoke(key))
			: await invoke(keys[0]);
		const latencyMs = Date.now() - startTime;
		await reportEffectiveness({
			backend,
			label: def.label,
			op: "search",
			ok: true,
			latencyMs,
			resultCount: result.results.length,
			onNotice: runtime?.onNotice,
		});
		return result.results;
	} catch (err) {
		await reportEffectiveness({
			backend,
			label: def.label,
			op: "search",
			ok: false,
			latencyMs: Date.now() - startTime,
			error: err,
			signal,
			onNotice: runtime?.onNotice,
		});
		if (def.providerAuth && isQuotaExhaustedError(err)) {
			const until = markHostedQuotaSkip(backend);
			runtime?.onNotice?.(
				`Search Hub ${def.label}: quota exhausted, skipping until ${new Date(until).toISOString()}.`,
			);
		}
		throw err;
	} finally {
		markCooldown(backend);
	}
}
