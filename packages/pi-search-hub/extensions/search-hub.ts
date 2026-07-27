/**
 * Extension — Unified web search (19 backends) + content extraction (web_read)
 *
 * Backends (choose any, all disabled by default):
 *   duckduckgo    — ✅ Free, no key, via Python ddgs lib. Rate-limited.
 *   jina          — ✅ Free tier (API key optional for higher rate limits), full markdown via s.jina.ai
 *   marginalia    — ✅ Anti-SEO, "public" key optional. 354ms avg
 *   serper        — ✅ Google via serper.dev, 2500 free/mo. 667ms
 *   brave         — ✅ Brave Search, 2000 free/mo. 460ms
 *   tavily        — ✅ AI search, 1000 free/mo. 356ms BEST QUALITY
 *   exa           — ✅ AI-native, 1000 free/mo. 137ms FASTEST
 *   firecrawl     — ✅ Search+crawl, keyless 1000 credits/mo (optional key). 644ms
 *   langsearch    — ✅ Free tier, no CC. 1816ms
 *   websearchapi  — ✅ Google-powered, 2000 free credits. 1323ms
 *   perplexity    — ✅ Unlimited free Sonar, citation-based answers
 *   searxng       — ✅ Self-hosted, 70+ aggregators. Needs instance URL
 *
 * Tools: web_search (auto-fallback + RRF combine modes), web_read (URL content)
 * Config: $PI_CODING_AGENT_DIR/extension-data/pi-search-hub/config.json + .pi/extension-data/pi-search-hub/config.json
 * Credentials: env var refs (ALL_CAPS), shell commands (!command), or literal keys
 *
 * Example .pi/extension-data/pi-search-hub/config.json:
 *   {
 *     "defaultBackend": "auto",
 *     "backends": {
 *       "duckduckgo": { "enabled": true },
 *       "marginalia": { "enabled": true },
 *       "serper": { "enabled": true, "apiKey": "..." },
 *       "tavily": { "enabled": true, "apiKey": "..." },
 *       "exa": { "enabled": true, "apiKey": "..." },
 *       "firecrawl": { "enabled": true, "apiKey": "..." },
 *       "langsearch": { "enabled": true, "apiKey": "..." },
 *       "websearchapi": { "enabled": true, "apiKey": "..." },
 *       "perplexity": { "enabled": true, "apiKey": "..." },
 *       "searxng": { "enabled": true, "instanceUrl": "http://localhost:8888" }
 *     }
 *   }
 */

import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	decorateToolForDisplay,
	withDisplaySummary,
} from "../../pi-tool-display-intent/tool-display-api-consumer.js";

import type { BackendConfig, ReaderName, SearchConfig, SearchResult, SearchResultWithBackend } from "./types.js";
import { timeoutSignal, sanitizeError, clearCooldowns, MISSING_KEY_HELP, validateUrl } from "./utils.js";
import { resolveBackendKey, getKeySource, FALLBACK_ENV_MAP } from "./credentials.js";
import { fetchSofya } from "./backends/sofya.js";
import { fetchFirecrawl } from "./backends/firecrawl.js";
import { fetchExaContents } from "./backends/exa.js";
import { fetchExaMCP } from "./backends/exa-mcp.js";
import { config, refreshConfig, getActiveBackends, recordLatency, latencyMap } from "./config.js";
import { loadMigratedSearchConfig, saveSearchConfig } from "./config-storage.js";
import {
	getGlobalConfigPath,
	getLegacyGlobalConfigPath,
	getLegacyProjectConfigPath,
	getProjectConfigPath,
} from "./paths.js";
import { BACKEND_DEFS, runBackend } from "./backends/registry.js";
import { selectBackendsForFallback, reciprocalRankFusion, runTargetedCombine } from "./dispatch.js";
import { formatResults, formatCombinedResults, formatResultsCompact, formatCombinedResultsCompact } from "./formatters.js";
import {
	getWebReadCallPresentation,
	getWebReadResultPresentation,
	getWebSearchCallPresentation,
	getWebSearchResultPresentation,
	WEB_READ_RESULT_MAX_CHARS,
} from "./display.js";

/** Cap on a single web_read response body, in bytes, to bound memory use on heavy pages. */
const READ_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const READER_NAMES = ["jina", "sofya", "firecrawl", "exa", "exa_mcp"] as const;
const READER_LABELS: Record<ReaderName, string> = {
	jina: "Jina",
	sofya: "Sofya",
	firecrawl: "Firecrawl",
	exa: "Exa",
	exa_mcp: "Exa MCP",
};

function configuredReaderOrder(searchConfig: SearchConfig): ReaderName[] {
	const configuredDefault = READER_NAMES.includes(searchConfig.reader as ReaderName)
		? searchConfig.reader as ReaderName
		: "jina";
	const configuredFallback = Array.isArray(searchConfig.readerFallback)
		? searchConfig.readerFallback
		: [];
	return Array.from(new Set([configuredDefault, ...configuredFallback].filter(
		(reader): reader is ReaderName => READER_NAMES.includes(reader as ReaderName),
	)));
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const withSearchHubDisplay = <T extends object>(
		tool: T,
		presentation: {
			getCallPresentation(args: unknown): { target: string; metadata?: string[] } | undefined;
			getResultPresentation(result: unknown): { summary: string; previewStartLine?: number } | undefined;
		},
	) => decorateToolForDisplay(
		withDisplaySummary(tool, {
			language: "auto",
			required: true,
		}),
		{
			kind: "generic",
			outputMode: "inherit",
			overrideExistingRenderers: true,
			...presentation,
		},
	);

	// -----------------------------------------------------------------------
	// Tool: web_search
	// -----------------------------------------------------------------------

	pi.registerTool(withSearchHubDisplay(defineTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using one of several backend search engines. " +
			"Supports DuckDuckGo (free, no key), " +
			"Marginalia Search (free, shared public key), Serper, Tavily, Exa, Brave, " +
			"LangSearch, Firecrawl, WebSearchAPI, Perplexity Sonar, and SearXNG (most need API keys). " +
			"The best available backend is used automatically. " +
			"Use combine=true to query all enabled backends in parallel for broader coverage. " +
			"Use for fact-finding, research, documentation lookups, and current events.",
		promptSnippet: "Search the web (supports multiple search backends)",
		promptGuidelines: [
			"Use web_search when you need up-to-date information, facts, or documentation from the web",
			"Auto mode tries enabled backends in order (DuckDuckGo is the free fallback)",
			"Set combine=true to query enabled backends in parallel and merge/deduplicate results",
			"Set combineMode=targeted in search.json to cap combine fan-out while still using multiple backends",
			"Configure additional backends in .pi/extension-data/pi-search-hub/config.json for better quality results",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Search query (natural language works best)",
			}),
			numResults: Type.Optional(
				Type.Number({
					description: "Number of results (1-20, default 10)",
					default: 10,
				}),
			),
			backend: Type.Optional(
				StringEnum(["duckduckgo", "jina", "marginalia", "serper", "tavily", "exa", "exa_mcp",
					"openai-codex", "brave", "brave-llm", "langsearch", "firecrawl", "websearchapi", "perplexity",
					"searxng", "linkup", "youcom", "fastcrw", "sofya", "auto"] as const, {
					description:
						"Backend to use. 'auto' picks the best configured backend (default)",
				}),
			),
			combine: Type.Optional(
				Type.Boolean({
					description:
						"When true, queries enabled backends in parallel and merges/deduplicates results. " +
						"Config combineMode controls whether this uses all backends or targeted fan-out. " +
						"Default is false (fallback mode: uses first successful backend only). " +
						"Ignored when a specific backend is requested (backend != 'auto').",
					default: false,
				}),
			),
			compact: Type.Optional(
				Type.Boolean({
					description:
						"When true, returns compact single-line results (title + URL). " +
						"Can also be set as default in search.json config. Default: false (verbose).",
					default: false,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			refreshConfig(ctx.cwd, ctx.isProjectTrusted(), false, notifyMigration(ctx));
			const numResults = Math.max(1, Math.min(params.numResults ?? 10, 20));
			const requestedBackend = params.backend || "auto";
			const combine = params.combine ?? false;
			const compact = params.compact ?? config.compact ?? false;
			const combineMode = (() => {
				const raw = config.combineMode;
				if (raw === "all" || raw === "targeted") return raw;
				if (raw !== undefined) {
					console.warn(`search-hub: unrecognized combineMode "${raw}", falling back to "all"`);
				}
				return "all";
			})();
			// If config has combine:true, force combine mode regardless of LLM choice
			const forceCombine = config.combine === true;
			const effectiveCombine = forceCombine || combine;

			const updateActivity = (status: string) => {
				onUpdate?.({
					content: [{ type: "text", text: `*${status}*` }],
					details: { activity: status },
				});
			};
			const runSearchBackend = (
				backend: string,
				query: string,
				limit: number,
				backendSignal?: AbortSignal,
			) => runBackend(backend, query, limit, backendSignal, {
				getProviderApiKey: (provider) => ctx.modelRegistry.getApiKeyForProvider(provider),
			});

			if (requestedBackend !== "auto") {
				// Specific backend requested — try it directly
				const backendLabel = BACKEND_DEFS[requestedBackend]?.label || requestedBackend;
				updateActivity(`🔍 ${backendLabel}: searching...`);
				try {
					const results = await runSearchBackend(requestedBackend, params.query, numResults, signal);
					updateActivity(`🔍 ${backendLabel}: ${results.length} results`);
					return {
						content: [{ type: "text", text: compact ? formatResultsCompact(results) : formatResults(params.query, requestedBackend, results) }],
						details: { backend: requestedBackend, resultCount: results.length },
					};
				} catch (err) {
					updateActivity(`❌ ${backendLabel}: failed`);
					throw err;
				}
			}

			// Auto mode
			const activeBackends = getActiveBackends();

			if (effectiveCombine) {
				if (combineMode === "targeted") {
					const orderedBackends = selectBackendsForFallback(
						config.selectionStrategy ?? "sequential",
						activeBackends,
					);
					updateActivity(`🔍 targeted combine: up to 3 of ${activeBackends.length} backends...`);
					const {
						results: combined,
						backendStats,
						usableBackendCount,
					} = await runTargetedCombine({
						orderedBackends,
						query: params.query,
						numResults,
						signal,
						runBackend: runSearchBackend,
					});

					if (usableBackendCount === 0) {
						updateActivity(`❌ targeted combine: no usable backends`);
						const errors = Array.from(backendStats.entries()).map(([backend, stats]) => (
							stats.success
								? `${backend}: 0 results`
								: `${backend}: ${stats.error || "failed"}`
						));
						throw new Error(`Targeted combine found no usable backend results: ${errors.join("; ")}`);
					}

					const attemptedCount = backendStats.size;
					const incomplete = usableBackendCount < 3 ? `, exhausted after ${usableBackendCount} usable` : "";
					updateActivity(`🔍 targeted combined: ${combined.length} results (${usableBackendCount}/${attemptedCount} usable${incomplete})`);

					return {
						content: [
							{
								type: "text",
								text: compact
									? formatCombinedResultsCompact(combined)
									: formatCombinedResults(params.query, combined, backendStats, BACKEND_DEFS),
							},
						],
						details: {
							backend: "combined-targeted",
							resultCount: combined.length,
							usableBackendCount,
							backendStats: Object.fromEntries(backendStats),
						},
					};
				}

				// Combine mode: query all enabled backends in parallel
				updateActivity(`🔍 combine: ${activeBackends.length} backends...`);
				const resultsPerBackend = await Promise.all(
					activeBackends.map(async (backend) => {
						try {
							const results = await runSearchBackend(
								backend,
								params.query,
								Math.ceil(numResults / activeBackends.length),
								signal,
							);
							return {
								backend,
								results: results.map((r) => ({ ...r, backend })) as SearchResultWithBackend[],
								success: true,
							};
						} catch (err) {
							return {
								backend,
								results: [] as SearchResultWithBackend[],
								success: false,
								error: (err as Error).message,
							};
						}
					}),
				);

				// Build backend stats map
				const backendStats = new Map<
					string,
					{ success: boolean; count: number; error?: string }
				>();

				for (const { backend, results, success, error } of resultsPerBackend) {
					backendStats.set(backend, {
						success,
						count: results.length,
						error,
					});
				}

				// Merge and re-rank using Reciprocal Rank Fusion
				const successfulBackends = resultsPerBackend
					.filter(r => r.success && r.results.length > 0)
					.map(r => ({ backend: r.backend, results: r.results }));

				const combined = successfulBackends.length > 0
					? reciprocalRankFusion(successfulBackends, numResults)
					: [];

				const successCount = successfulBackends.length;
				const failCount = activeBackends.length - successCount;
				updateActivity(`🔍 combined: ${combined.length} results (${successCount} ok${failCount > 0 ? `, ${failCount} failed` : ""})`);

				return {
					content: [
						{
							type: "text",
							text: compact
								? formatCombinedResultsCompact(combined)
							: formatCombinedResults(params.query, combined, backendStats, BACKEND_DEFS),
						},
					],
					details: {
						backend: "combined",
						resultCount: combined.length,
						backendStats: Object.fromEntries(backendStats),
					},
				};
			} else {
				// Fallback mode: select backends using configured strategy
				const orderedBackends = selectBackendsForFallback(
					config.selectionStrategy ?? "sequential",
					activeBackends,
				);
				const errors: string[] = [];
				for (const backend of orderedBackends) {
					const backendLabel = BACKEND_DEFS[backend]?.label || backend;
					const t0 = Date.now();
					updateActivity(`🔍 ${backendLabel}: searching...`);
					try {
						const results = await runSearchBackend(backend, params.query, numResults, signal);
						recordLatency(backend, Date.now() - t0);
						updateActivity(`🔍 ${backendLabel}: ${results.length} results`);
						return {
							content: [
								{
									type: "text",
									text: errors.length > 0
										? `${errors.join("; ")}\n\n${compact ? formatResultsCompact(results) : formatResults(params.query, backend, results)}`
										: (compact ? formatResultsCompact(results) : formatResults(params.query, backend, results)),
								},
							],
							details: {
								backend: errors.length > 0 ? `${backend} (fallback)` : backend,
								resultCount: results.length,
								errors: errors.length > 0 ? errors : undefined,
							},
						};
					} catch (err) {
						errors.push(`${backend}: ${(err as Error).message}`);
						updateActivity(`❌ ${backendLabel}: failed, trying next...`);
					}
				}

				updateActivity(`❌ all backends failed`);
				throw new Error(`All backends failed: ${errors.join("; ")}`);
			}
		},
	}), {
		getCallPresentation: getWebSearchCallPresentation,
		getResultPresentation: getWebSearchResultPresentation,
	}));

	// -----------------------------------------------------------------------
	// Tool: web_read — Read/extract content from a URL
	// -----------------------------------------------------------------------

	pi.registerTool(withSearchHubDisplay(defineTool({
		name: "web_read",
		label: "Read Web Page",
		description:
			"Fetch a URL as markdown. Use keywords for long pages and objective only for a Jina CSS target selector, " +
			"rush for speed, smart for better narrowing. When reader is omitted, Search Hub tries the configured " +
			"default reader and ordered fallbacks. An explicit reader disables fallback for that call.",
		promptSnippet: "Read content from a web page (supports markdown extraction)",
		promptGuidelines: [
			"Use web_read when you need to read the content of a specific URL",
			"Set web_read objective only to a valid CSS selector for Jina targeted extraction; do not pass a natural-language question",
			"Add keywords for long pages when you know the relevant terms",
			"Choose rush for speed or smart for higher-quality narrowing",
		],
		parameters: Type.Object({
			url: Type.String({
				description: "HTTP(S) URL or bare domain to fetch",
			}),
			fresh: Type.Optional(
				Type.Boolean({
					description: "Bypass cache when freshness matters",
				}),
			),
			keywords: Type.Optional(
				Type.Array(Type.String(), {
					description: "Keyword to focus extraction on relevant sections",
				}),
			),
			mode: Type.Optional(
				StringEnum(["rush", "smart"] as const, {
					description: "rush = faster mode, smart = better section selection on long/noisy pages",
				}),
			),
			objective: Type.Optional(
				Type.String({
					description:
						"CSS selector for targeted extraction. Use when only part of the page matters. (Jina reader only.)",
				}),
			),
			reader: Type.Optional(
				StringEnum(READER_NAMES, {
					description:
						"Reader backend: 'jina' (default, free, supports keywords/mode/objective), " +
						"'sofya' (250+ site-specific parsers, needs API key), " +
						"'firecrawl' (keyless, 1000 credits/mo), " +
						"'exa' (needs API key, 1000 req/mo), or " +
						"'exa_mcp' (zero-config, rate-limited). Explicit selection skips configured fallback readers.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			refreshConfig(ctx.cwd, ctx.isProjectTrusted(), false, notifyMigration(ctx));

			const updateActivity = (status: string, reader: ReaderName) => {
				onUpdate?.({
					content: [{ type: "text", text: `*${status}*` }],
					details: { activity: status, reader },
				});
			};

			const url = params.url.startsWith("https://") || params.url.startsWith("http://")
				? params.url
				: `https://${params.url}`;

			// SSRF guard — block private/internal addresses regardless of reader.
			const ssrfError = validateUrl(url);
			if (ssrfError) {
				throw new Error(ssrfError);
			}

			const explicitReader = params.reader as ReaderName | undefined;
			const readers = explicitReader ? [explicitReader] : configuredReaderOrder(config);

			const fetchWithReader = async (reader: ReaderName): Promise<string> => {
				if (reader === "sofya") {
					const sofyaKey = resolveBackendKey("sofya", config);
					if (!sofyaKey) {
						throw new Error(`Sofya reader selected but no API key configured. ${MISSING_KEY_HELP}`);
					}
					return (await fetchSofya(url, sofyaKey, signal)).content;
				}
				if (reader === "firecrawl") {
					const firecrawlKey = resolveBackendKey("firecrawl", config);
					return (await fetchFirecrawl(url, firecrawlKey, signal)).content;
				}
				if (reader === "exa") {
					const exaKey = resolveBackendKey("exa", config);
					if (!exaKey) {
						throw new Error(`Exa reader selected but no API key configured. ${MISSING_KEY_HELP}`);
					}
					const result = await fetchExaContents(url, exaKey, signal);
					if (result.warning) ctx.ui.notify(result.warning, "warning");
					return result.content;
				}
				if (reader === "exa_mcp") {
					return (await fetchExaMCP(url, signal)).content;
				}

				const readerUrl = new URL("https://r.jina.ai/" + url);
				const headers: Record<string, string> = { "Accept": "text/plain" };
				const jinaKey = resolveBackendKey("jina", config);
				if (jinaKey) headers["Authorization"] = `Bearer ${jinaKey}`;
				if (params.fresh) headers["x-no-cache"] = "true";
				if (params.keywords && params.keywords.length > 0) {
					headers["x-keywords"] = params.keywords.join(", ");
				}
				if (params.mode) headers["x-respond-with"] = params.mode === "rush" ? "text" : "markdown";
				if (params.objective) headers["x-target-selector"] = params.objective;

				const response = await fetch(readerUrl.toString(), {
					signal: timeoutSignal(signal),
					headers,
				});
				if (!response.ok) {
					const text = await response.text().catch(() => "");
					throw new Error(`Failed to read ${url}: ${sanitizeError(response.status, text)}`);
				}

				const contentLength = parseInt(response.headers.get("content-length") ?? "", 10);
				if (Number.isFinite(contentLength) && contentLength > READ_MAX_BYTES) {
					throw new Error(`Failed to read ${url}: response too large (${contentLength} bytes, limit ${READ_MAX_BYTES})`);
				}
				return response.text();
			};

			const errors: string[] = [];
			let content: string | undefined;
			let reader: ReaderName | undefined;
			for (const [index, candidate] of readers.entries()) {
				const label = READER_LABELS[candidate];
				updateActivity(`📄 ${label}: fetching...`, candidate);
				try {
					content = await fetchWithReader(candidate);
					reader = candidate;
					break;
				} catch (error) {
					if (signal?.aborted || explicitReader) throw error;
					errors.push(`${candidate}: ${(error as Error).message}`);
					const next = readers[index + 1];
					if (next) {
						updateActivity(`❌ ${label}: failed; trying ${READER_LABELS[next]}...`, candidate);
					}
				}
			}

			if (content === undefined || reader === undefined) {
				throw new Error(`All configured readers failed: ${errors.join("; ")}`);
			}

			updateActivity(`📄 ${READER_LABELS[reader]}: ${content.length} chars`, reader);
			const truncated = content.length > WEB_READ_RESULT_MAX_CHARS
				? content.slice(0, WEB_READ_RESULT_MAX_CHARS) + `\n\n[... truncated, full length: ${content.length} chars]`
				: content;

			return {
				content: [{ type: "text", text: truncated }],
				details: {
					url,
					reader,
					length: content.length,
					truncated: content.length > WEB_READ_RESULT_MAX_CHARS,
					fallbackErrors: errors.length > 0 ? errors : undefined,
				},
			};
		},
	}), {
		getCallPresentation: (args) => getWebReadCallPresentation(args, configuredReaderOrder(config)[0]),
		getResultPresentation: getWebReadResultPresentation,
	}));

	// -----------------------------------------------------------------------
	// Commands
	// -----------------------------------------------------------------------

	const notifyMigration = (ctx: ExtensionContext) => (message: string): void => {
		if (ctx.hasUI === false) console.warn(message);
		else ctx.ui.notify(message, "warning");
	};

	function readGlobalConfig(ctx: ExtensionContext): SearchConfig {
		return loadMigratedSearchConfig({
			targetPath: getGlobalConfigPath(),
			legacyPath: getLegacyGlobalConfigPath(),
			scope: "global",
			onNotice: notifyMigration(ctx),
		});
	}

	function writeGlobalConfig(nextConfig: SearchConfig): void {
		saveSearchConfig(getGlobalConfigPath(), nextConfig);
	}

	function cloneConfig(value: SearchConfig): SearchConfig {
		return JSON.parse(JSON.stringify(value)) as SearchConfig;
	}

	function readProjectConfig(ctx: ExtensionContext): SearchConfig {
		if (!ctx.isProjectTrusted()) return {};
		return loadMigratedSearchConfig({
			targetPath: getProjectConfigPath(ctx.cwd),
			legacyPath: getLegacyProjectConfigPath(ctx.cwd),
			scope: "project",
			onNotice: notifyMigration(ctx),
		});
	}

	function effectiveDraftConfig(globalDraft: SearchConfig, ctx: ExtensionContext): SearchConfig {
		const project = readProjectConfig(ctx);
		const globalBackends = { ...(globalDraft.backends ?? {}) } as Record<string, BackendConfig | undefined>;
		const projectBackends = project.backends && typeof project.backends === "object"
			? project.backends as Record<string, BackendConfig | undefined>
			: undefined;
		const merged: SearchConfig = {
			defaultBackend: "duckduckgo",
			backends: globalBackends,
			...cloneConfig(globalDraft),
			...cloneConfig(project),
		};
		if (projectBackends) {
			const backends = { ...globalBackends };
			for (const [backend, projectBackend] of Object.entries(projectBackends)) {
				backends[backend] = projectBackend
					? { ...(globalBackends[backend] ?? {}), ...projectBackend }
					: projectBackend;
			}
			merged.backends = backends;
		} else {
			merged.backends = globalBackends;
		}
		for (const [backend, envName] of Object.entries(FALLBACK_ENV_MAP)) {
			if (!process.env[envName]?.trim()) continue;
			const current = (merged.backends as Record<string, BackendConfig | undefined>)[backend];
			if (!current || current.enabled === undefined) {
				(merged.backends as Record<string, BackendConfig | undefined>)[backend] = {
					...current,
					enabled: true,
				};
			}
		}
		return merged;
	}

	function activeBackendsFor(stateConfig: SearchConfig): string[] {
		const enabled = Object.entries(stateConfig.backends ?? {})
			.filter(([, backendConfig]) => backendConfig?.enabled)
			.map(([backend]) => backend);
		const active = enabled.length > 0 ? enabled : ["duckduckgo"];
		return stateConfig.defaultBackend && active.includes(stateConfig.defaultBackend)
			? [stateConfig.defaultBackend, ...active.filter((backend) => backend !== stateConfig.defaultBackend)]
			: active;
	}

	type SetupDraftState = {
		original: SearchConfig;
		draft: SearchConfig;
	};

	function refreshRuntimeConfig(ctx: ExtensionContext): void {
		refreshConfig(ctx.cwd, ctx.isProjectTrusted(), true, notifyMigration(ctx));
	}

	function authSourceLabel(source: string): string {
		if (source.startsWith("env:")) return `env ${source.slice(4)}`;
		if (source.startsWith("shell:")) return "shell command";
		if (source === "literal") return "saved key";
		return source || "configured";
	}

	function configuredAuthDetail(source: string, optional = false): string {
		const suffix = optional ? " (optional)" : "";
		return source.startsWith("shell:")
			? `auth ? shell command${suffix}`
			: `auth ✓ ${authSourceLabel(source)}${suffix}`;
	}

	function piAuthDetail(ctx: ExtensionContext): string {
		try {
			const auth = ctx.modelRegistry.getProviderAuthStatus("openai-codex");
			if (!auth.configured) return "auth ✗ run /login openai-codex";
			if (auth.source === "stored") return "auth ✓ Pi /login";
			if (auth.source === "environment") return "auth ✓ Pi environment";
			if (auth.source === "runtime") return "auth ✓ Pi runtime";
			return "auth ✓ Pi credential";
		} catch {
			return "auth ? Pi status unavailable";
		}
	}

	function backendStateSummary(
		backend: string,
		stateConfig: SearchConfig,
		activeBackends: readonly string[],
		codexAuth: string,
	): { marker: "ON" | "OFF" | "AUTO"; details: string } {
		const def = BACKEND_DEFS[backend];
		const bc = (stateConfig.backends as Record<string, BackendConfig> | undefined)?.[backend];
		const { configured, source } = getKeySource(backend, stateConfig);
		const marker = bc?.enabled
			? "ON"
			: backend === "duckduckgo" && activeBackends.includes(backend)
				? "AUTO"
				: "OFF";
		const details: string[] = [];

		if (backend === "openai-codex") {
			details.push(codexAuth);
		} else if (def.needsKey) {
			details.push(configured
				? configuredAuthDetail(source)
				: marker === "ON" ? "auth ✗ missing" : "auth — not configured");
		} else if (def.optionalKey) {
			details.push(configured ? configuredAuthDetail(source, true) : "auth — optional");
		} else {
			details.push("auth — not required");
		}
		if (def.needsInstanceUrl) {
			details.push(bc?.instanceUrl?.trim() ? "URL ✓" : "URL ✗ missing");
		}
		return { marker, details: details.join(" · ") };
	}

	function searchMode(searchConfig: SearchConfig): "fallback" | "targeted" | "all" {
		if (!searchConfig.combine) return "fallback";
		return searchConfig.combineMode === "targeted" ? "targeted" : "all";
	}

	function searchModeLabel(mode: ReturnType<typeof searchMode>): string {
		if (mode === "targeted") return "Targeted combine";
		if (mode === "all") return "All-backend combine";
		return "Fallback";
	}

	function averageLatency(backend: string): string | undefined {
		const samples = latencyMap.get(backend) ?? [];
		if (samples.length === 0) return undefined;
		return `${Math.round(samples.reduce((sum, sample) => sum + sample.ms, 0) / samples.length)}ms avg`;
	}

	function valuesEqual(left: unknown, right: unknown): boolean {
		return JSON.stringify(left) === JSON.stringify(right);
	}

	function draftIsDirty(state: SetupDraftState): boolean {
		return !valuesEqual(state.original, state.draft);
	}

	function updateDraftBackend(state: SetupDraftState, backend: string, patch: BackendConfig): void {
		const current = (state.draft.backends as Record<string, BackendConfig> | undefined)?.[backend] ?? {};
		state.draft = {
			...state.draft,
			backends: {
				...state.draft.backends,
				[backend]: { ...current, ...patch },
			},
		};
	}

	function configuredCredentialCount(ctx: ExtensionContext, stateConfig: SearchConfig): number {
		return Object.keys(BACKEND_DEFS).filter((backend) => {
			if (backend === "openai-codex") return piAuthDetail(ctx).startsWith("auth ✓");
			return getKeySource(backend, stateConfig).configured;
		}).length;
	}

	function setupHomeTitle(ctx: ExtensionContext, state: SetupDraftState): string {
		const effective = effectiveDraftConfig(state.draft, ctx);
		const active = activeBackendsFor(effective);
		const defaultBackend = effective.defaultBackend && active.includes(effective.defaultBackend)
			? effective.defaultBackend
			: active[0] ?? "none";
		const readers = configuredReaderOrder(effective).map((reader) => READER_LABELS[reader]);
		return [
			"Search Hub setup",
			draftIsDirty(state) ? "● Unsaved changes" : "No unsaved changes",
			`Search: ${searchModeLabel(searchMode(effective))} · default ${defaultBackend}`,
			`Reading: ${readers.join(" → ")}`,
			`Backends: ${active.length} active · ${configuredCredentialCount(ctx, effective)} credentials configured`,
			`Output: compact ${effective.compact ? "on" : "off"}`,
		].join("\n");
	}

	function normalizeDraft(draft: SearchConfig): SearchConfig {
		const normalized = cloneConfig(draft) as SearchConfig & Record<string, unknown>;
		delete normalized.showStatus;
		delete normalized.cacheTtl;
		delete normalized.cacheMax;

		if (normalized.reader && !READER_NAMES.includes(normalized.reader)) delete normalized.reader;
		const defaultReader = normalized.reader ?? "jina";
		normalized.readerFallback = Array.from(new Set(normalized.readerFallback ?? []))
			.filter((reader): reader is ReaderName => READER_NAMES.includes(reader) && reader !== defaultReader);

		const normalizedBackends: Record<string, BackendConfig> = {};
		for (const [backend, backendConfig] of Object.entries(normalized.backends ?? {})) {
			if (!backendConfig) continue;
			const cleaned = { ...backendConfig };
			if (typeof cleaned.apiKey === "string") {
				cleaned.apiKey = cleaned.apiKey.trim();
				if (!cleaned.apiKey) delete cleaned.apiKey;
			}
			if (typeof cleaned.instanceUrl === "string") {
				cleaned.instanceUrl = cleaned.instanceUrl.trim();
				if (!cleaned.instanceUrl) delete cleaned.instanceUrl;
			}
			normalizedBackends[backend] = cleaned;
		}
		normalized.backends = normalizedBackends;

		const active = activeBackendsFor(normalized);
		if (!normalized.defaultBackend || !active.includes(normalized.defaultBackend)) {
			normalized.defaultBackend = active[0];
		}
		return normalized;
	}

	function saveDraft(ctx: ExtensionContext, state: SetupDraftState): boolean {
		try {
			const saved = normalizeDraft(state.draft);
			writeGlobalConfig(saved);
			state.original = cloneConfig(saved);
			state.draft = cloneConfig(saved);
			refreshRuntimeConfig(ctx);
			const hasProjectOverrides = Object.keys(readProjectConfig(ctx)).length > 0;
			ctx.ui.notify(
				hasProjectOverrides
					? "Search Hub configuration saved and applied. Current project overrides remain effective."
					: "Search Hub configuration saved and applied.",
				"info",
			);
			return true;
		} catch (error) {
			ctx.ui.notify(`Failed to save Search Hub configuration: ${(error as Error).message}`, "error");
			return false;
		}
	}

	async function confirmSetupClose(ctx: ExtensionContext, state: SetupDraftState): Promise<boolean> {
		if (!draftIsDirty(state)) return true;
		const choice = await ctx.ui.select("Unsaved Search Hub changes", [
			"Save & apply",
			"Discard changes",
			"Continue editing",
		]);
		if (choice === "Save & apply") return saveDraft(ctx, state);
		return choice === "Discard changes";
	}

	async function configureBackend(ctx: ExtensionContext, backend: string, state: SetupDraftState): Promise<void> {
		const def = BACKEND_DEFS[backend];
		const globalBackend = (state.draft.backends as Record<string, BackendConfig> | undefined)?.[backend];
		const globalEnabled = globalBackend?.enabled === true;
		const codexAuth = piAuthDetail(ctx);
		const globalState = backendStateSummary(backend, state.draft, activeBackendsFor(state.draft), codexAuth);
		const effective = effectiveDraftConfig(state.draft, ctx);
		const effectiveState = backendStateSummary(backend, effective, activeBackendsFor(effective), codexAuth);
		const title = [
			def.label,
			`Global draft:         [${globalState.marker}] ${globalState.details}`,
			`Effective after save: [${effectiveState.marker}] ${effectiveState.details}`,
		].join("\n");
		const actions = [
			globalEnabled ? "Disable globally (keep credentials)" : "Enable in global configuration",
		];
		if (def.needsInstanceUrl) actions.push("Update instance URL");
		if (def.needsKey || def.optionalKey) {
			actions.push(globalBackend?.apiKey ? "Update API key or reference" : "Set API key or reference");
			if (globalBackend?.apiKey) actions.push("Remove saved API key or reference");
		}
		if (backend === "openai-codex") actions.push("Configure Pi auth with /login");
		actions.push("↩ Back");

		const action = await ctx.ui.select(title, actions);
		if (!action || action === "↩ Back") return;
		if (action === "Disable globally (keep credentials)") {
			updateDraftBackend(state, backend, { enabled: false });
			return;
		}
		if (action === "Configure Pi auth with /login") {
			ctx.ui.notify("Run /login openai-codex to configure Pi authentication.", "info");
			return;
		}
		if (action === "Remove saved API key or reference") {
			updateDraftBackend(state, backend, { apiKey: undefined });
			return;
		}
		if (action === "Update instance URL") {
			const instanceUrl = await ctx.ui.input(
				"Enter your instance URL (e.g. http://localhost:8888):",
				globalBackend?.instanceUrl ?? "http://localhost:8888",
			);
			const trimmedUrl = instanceUrl?.trim() ?? "";
			if (!trimmedUrl) {
				ctx.ui.notify("An instance URL is required. Draft unchanged.", "warning");
				return;
			}
			updateDraftBackend(state, backend, { instanceUrl: trimmedUrl });
			return;
		}
		if (action === "Set API key or reference" || action === "Update API key or reference") {
			const key = await ctx.ui.input(
				`Enter your ${def.label} key, ENV_VAR reference, or !command:`,
				"sk-...",
			);
			const trimmedKey = key?.trim() ?? "";
			if (!trimmedKey) {
				ctx.ui.notify("Draft unchanged.", "warning");
				return;
			}
			updateDraftBackend(state, backend, { apiKey: trimmedKey });
			return;
		}

		const patch: BackendConfig = { enabled: true };
		if (def.needsInstanceUrl && !globalBackend?.instanceUrl?.trim()) {
			const instanceUrl = await ctx.ui.input(
				"Enter your instance URL (e.g. http://localhost:8888):",
				"http://localhost:8888",
			);
			const trimmedUrl = instanceUrl?.trim() ?? "";
			if (!trimmedUrl) {
				ctx.ui.notify("An instance URL is required. Draft unchanged.", "warning");
				return;
			}
			patch.instanceUrl = trimmedUrl;
		}
		if (def.needsKey && !getKeySource(backend, state.draft).configured) {
			const key = await ctx.ui.input(
				`Enter your ${def.label} key, ENV_VAR reference, or !command:`,
				"sk-...",
			);
			const trimmedKey = key?.trim() ?? "";
			if (!trimmedKey) {
				ctx.ui.notify("An API key or credential reference is required. Draft unchanged.", "warning");
				return;
			}
			patch.apiKey = trimmedKey;
		}
		updateDraftBackend(state, backend, patch);
	}

	function enableReadyKeylessBackends(state: SetupDraftState): void {
		for (const backend of ["duckduckgo", "jina", "marginalia", "exa_mcp"]) {
			updateDraftBackend(state, backend, { enabled: true });
		}
	}

	async function configureReaderFallback(ctx: ExtensionContext, state: SetupDraftState): Promise<void> {
		const current = configuredReaderOrder(state.draft).slice(1);
		const action = await ctx.ui.select(
			`Reader fallback order: ${current.length > 0 ? current.join(" → ") : "none"}`,
			["Edit ordered fallback list", "Clear fallback list", "↩ Back"],
		);
		if (!action || action === "↩ Back") return;
		if (action === "Clear fallback list") {
			state.draft = { ...state.draft, readerFallback: [] };
			return;
		}

		const input = await ctx.ui.input(
			"Comma-separated readers (jina, sofya, firecrawl, exa, exa_mcp):",
			current.join(", "),
		);
		if (!input?.trim()) {
			ctx.ui.notify("Draft unchanged. Use Clear fallback list to remove all fallbacks.", "info");
			return;
		}
		const requested = Array.from(new Set(input.split(",").map((reader) => reader.trim()).filter(Boolean)));
		const invalid = requested.filter((reader) => !READER_NAMES.includes(reader as ReaderName));
		if (invalid.length > 0) {
			ctx.ui.notify(`Unknown readers: ${invalid.join(", ")}`, "error");
			return;
		}
		const defaultReader = configuredReaderOrder(state.draft)[0];
		const fallback = requested.filter((reader): reader is ReaderName => reader !== defaultReader) as ReaderName[];
		state.draft = { ...state.draft, readerFallback: fallback };
	}

	async function configureSearchRouting(ctx: ExtensionContext, state: SetupDraftState): Promise<void> {
		while (true) {
			const active = activeBackendsFor(state.draft);
			const settings = [
				`Default search backend: ${state.draft.defaultBackend ?? active[0] ?? "none"}`,
				`Search mode: ${searchModeLabel(searchMode(state.draft))}`,
				`Selection strategy: ${state.draft.selectionStrategy ?? "sequential"}`,
				"↩ Back",
			];
			const selected = await ctx.ui.select(
				`Search routing${draftIsDirty(state) ? " · unsaved" : ""}`,
				settings,
			);
			if (!selected || selected === "↩ Back") return;

			if (selected.startsWith("Default search backend:")) {
				const choice = await ctx.ui.select("Default search backend:", [...active, "↩ Back"]);
				if (!choice || choice === "↩ Back") continue;
				state.draft = { ...state.draft, defaultBackend: choice };
				continue;
			}
			if (selected.startsWith("Search mode:")) {
				const choice = await ctx.ui.select(
					"Search mode:",
					["Fallback", "Targeted combine", "All-backend combine", "↩ Back"],
				);
				if (!choice || choice === "↩ Back") continue;
				const mode = choice === "Targeted combine" ? "targeted" : choice === "All-backend combine" ? "all" : "fallback";
				if (mode === "fallback") {
					const next = { ...state.draft, combine: false };
					delete next.combineMode;
					state.draft = next;
				} else {
					state.draft = { ...state.draft, combine: true, combineMode: mode };
				}
				continue;
			}
			if (selected.startsWith("Selection strategy:")) {
				const choice = await ctx.ui.select(
					"Selection strategy:",
					["sequential", "random", "round-robin", "best-latency", "↩ Back"],
				);
				if (!choice || choice === "↩ Back") continue;
				state.draft = { ...state.draft, selectionStrategy: choice as SearchConfig["selectionStrategy"] };
			}
		}
	}

	async function configureWebReading(ctx: ExtensionContext, state: SetupDraftState): Promise<void> {
		while (true) {
			const readerOrder = configuredReaderOrder(state.draft);
			const fallback = readerOrder.slice(1);
			const settings = [
				`Default reader: ${READER_LABELS[readerOrder[0]]}`,
				`Reader fallback order: ${fallback.length > 0 ? fallback.join(" → ") : "none"}`,
				"↩ Back",
			];
			const selected = await ctx.ui.select(
				`Web reading${draftIsDirty(state) ? " · unsaved" : ""}`,
				settings,
			);
			if (!selected || selected === "↩ Back") return;

			if (selected.startsWith("Default reader:")) {
				const options = READER_NAMES.map((reader) => `${READER_LABELS[reader]} (${reader})`);
				const choice = await ctx.ui.select("Default reader:", [...options, "↩ Back"]);
				if (!choice || choice === "↩ Back") continue;
				const reader = READER_NAMES.find((name) => choice.endsWith(`(${name})`));
				if (!reader) continue;
				const readerFallback = configuredReaderOrder(state.draft).filter((candidate) => candidate !== reader);
				state.draft = { ...state.draft, reader, readerFallback };
				continue;
			}
			if (selected.startsWith("Reader fallback order:")) {
				await configureReaderFallback(ctx, state);
			}
		}
	}

	async function configureOutput(ctx: ExtensionContext, state: SetupDraftState): Promise<void> {
		while (true) {
			const selected = await ctx.ui.select(
				`Output${draftIsDirty(state) ? " · unsaved" : ""}`,
				[`Compact output: ${state.draft.compact ? "On" : "Off"}`, "↩ Back"],
			);
			if (!selected || selected === "↩ Back") return;
			const choice = await ctx.ui.select("Compact output:", ["On", "Off", "↩ Back"]);
			if (!choice || choice === "↩ Back") continue;
			state.draft = { ...state.draft, compact: choice === "On" };
		}
	}

	async function configureBackends(ctx: ExtensionContext, state: SetupDraftState): Promise<void> {
		while (true) {
			const effective = effectiveDraftConfig(state.draft, ctx);
			const active = activeBackendsFor(effective);
			const codexAuth = piAuthDetail(ctx);
			const backendEntries = Object.keys(BACKEND_DEFS).map((backend) => {
				const backendState = backendStateSummary(backend, effective, active, codexAuth);
				const globalEnabled = (state.draft.backends as Record<string, BackendConfig> | undefined)?.[backend]?.enabled === true;
				const effectiveEnabled = (effective.backends as Record<string, BackendConfig> | undefined)?.[backend]?.enabled === true;
				const override = globalEnabled === effectiveEnabled
					? ""
					: ` · global ${globalEnabled ? "ON" : "OFF"} → effective ${effectiveEnabled ? "ON" : "OFF"}`;
				const latency = averageLatency(backend);
				const option = `[${backendState.marker}] ${BACKEND_DEFS[backend].label} · ${backendState.details}${override}${latency ? ` · ${latency}` : ""}`;
				return { backend, option };
			});
			const backendByOption = Object.fromEntries(backendEntries.map(({ backend, option }) => [option, backend]));
			const title = [
				"Search backends",
				draftIsDirty(state) ? "● Unsaved changes" : "No unsaved changes",
				`${active.length} active · ${configuredCredentialCount(ctx, effective)} credentials configured`,
			].join("\n");
			const option = await ctx.ui.select(title, [
				...backendEntries.map(({ option }) => option),
				"⚡ Enable ready keyless backends",
				"↩ Back",
			]);
			if (!option || option === "↩ Back") return;
			if (option === "⚡ Enable ready keyless backends") {
				enableReadyKeylessBackends(state);
				continue;
			}
			const backend = backendByOption[option];
			if (backend) await configureBackend(ctx, backend, state);
		}
	}

	pi.registerCommand("search-setup", {
		description: "View status and configure Search Hub",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/search-setup requires interactive mode", "error");
				return;
			}

			refreshRuntimeConfig(ctx);
			const original = readGlobalConfig(ctx);
			const state: SetupDraftState = {
				original: cloneConfig(original),
				draft: cloneConfig(original),
			};
			while (true) {
				const options = [
					"🔀 Search routing",
					"📖 Web reading",
					"🔌 Backends",
					"🖥 Output",
					"💾 Save & apply",
				];
				if (draftIsDirty(state)) options.push("↩ Discard changes");
				options.push("✅ Close");
				const option = await ctx.ui.select(setupHomeTitle(ctx, state), options);

				if (!option || option === "✅ Close") {
					if (!(await confirmSetupClose(ctx, state))) continue;
					ctx.ui.notify("Search setup complete.", "info");
					return;
				}
				if (option === "🔀 Search routing") {
					await configureSearchRouting(ctx, state);
					continue;
				}
				if (option === "📖 Web reading") {
					await configureWebReading(ctx, state);
					continue;
				}
				if (option === "🔌 Backends") {
					await configureBackends(ctx, state);
					continue;
				}
				if (option === "🖥 Output") {
					await configureOutput(ctx, state);
					continue;
				}
				if (option === "💾 Save & apply") {
					if (draftIsDirty(state)) saveDraft(ctx, state);
					else ctx.ui.notify("No unsaved Search Hub changes.", "info");
					continue;
				}
				if (option === "↩ Discard changes") {
					state.draft = cloneConfig(state.original);
					ctx.ui.notify("Unsaved Search Hub changes discarded.", "info");
				}
			}
		},
	});

	// -----------------------------------------------------------------------
	// Session start
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		clearCooldowns();
		refreshRuntimeConfig(ctx);
	});
}
