/**
 * Extension — Unified web search + content extraction (web_read)
 *
 * Backends (choose any, all disabled by default):
 *   exa          — AI-native search, needs API key
 *   tavily       — AI search, needs API key
 *   firecrawl    — Search+crawl, keyless 1000 credits/mo (optional key)
 *   parallel     — Official REST search + extract, needs API key
 *   openai-codex — Pi /login hosted web search
 *   xai          — Pi /login hosted web search (Grok)
 *
 * Tools: web_search (routed fallback + targeted combine), web_read (URL content)
 * Config: $PI_CODING_AGENT_DIR/extension-data/pi-search-hub/config.json + .pi/extension-data/pi-search-hub/config.json
 * Credentials: env var refs (ALL_CAPS), shell commands (!command), or literal keys
 *
 * Example .pi/extension-data/pi-search-hub/config.json:
 *   {
 *     "routing": "priority",
 *     "priority": ["exa", "firecrawl"],
 *     "backends": {
 *       "exa": { "enabled": true, "apiKeys": ["EXA_API_KEY"] },
 *       "firecrawl": { "enabled": true }
 *     }
 *   }
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { createDiagnosticReporter } from "./diagnostics.js";
import { readEffectivenessState, reportEffectiveness } from "./effectiveness.js";
import type { ReaderName, SearchResultWithBackend } from "./types.js";
import { READER_NAMES } from "./types.js";
import { clearCooldowns, MISSING_KEY_HELP, validateUrl } from "./utils.js";
import { resolveBackendKeys, withRotatedKeys } from "./credentials.js";
import { fetchFirecrawl } from "./backends/firecrawl.js";
import { fetchExaContents } from "./backends/exa.js";
import { fetchParallel } from "./backends/parallel.js";
import { getConfig, refreshConfig, getActiveBackends, routingOf } from "./config.js";
import { BACKEND_DEFS, runBackend } from "./backends/registry.js";
import { selectBackendsForFallback, runTargetedCombine } from "./dispatch.js";
import { filterQuotaSkipped } from "./quota-skips.js";
import { formatResults, formatCombinedResults, formatResultsCompact, formatCombinedResultsCompact } from "./formatters.js";
import {
	formatWebReadCallLine,
	formatWebReadResultLine,
	formatWebSearchCallLine,
	formatWebSearchResultLine,
	WEB_READ_RESULT_MAX_CHARS,
} from "./display.js";
import { openSearchSetup } from "./setup-ui.js";
import { openSearchStatus } from "./status-ui.js";

const READER_LABELS: Record<ReaderName, string> = {
	firecrawl: "Firecrawl",
	exa: "Exa",
	parallel: "Parallel",
};

const COMBINE_DESCRIPTION =
	"Query several enabled providers with the same query and merge deduplicated results, each tagged with its source. " +
	"Costs 2–3x quota; default false. Set true only when the user asks for multiple or independent sources, " +
	"when verifying a contested or high-stakes fact (versions, deprecations, security advisories, pricing/policy) " +
	"where independent indexes should agree, or when a well-formed single search returned too few or same-domain results. " +
	"Rephrasing the query fixes missing angles; combine only fixes index blind spots. " +
	"Do not enable it for routine docs, errors, or changelog lookups.";

function withSource(backend: string, results: SearchResultWithBackend[]): SearchResultWithBackend[] {
	return results.map((result) => ({ ...result, backend: result.backend ?? backend }));
}

function readerOrder(): ReaderName[] {
	return [...READER_NAMES];
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const diagnostics = createDiagnosticReporter();
	const withClaudeRows = <T extends object>(
		tool: T,
		formatCall: (args: unknown, theme: { fg(color: string, text: string): string; bold(text: string): string }, context?: { isError?: boolean; isPartial?: boolean }) => string,
		formatResult: (result: unknown, theme: { fg(color: string, text: string): string; bold(text: string): string }, context?: { isError?: boolean; isPartial?: boolean }) => string,
	) => ({
		...tool,
		renderCall(args: unknown, theme: { fg(color: string, text: string): string; bold(text: string): string }, context?: { isError?: boolean; isPartial?: boolean }) {
			return new Text(formatCall(args, theme, context), 0, 0);
		},
		renderResult(result: unknown, _options: unknown, theme: { fg(color: string, text: string): string; bold(text: string): string }, context?: { isError?: boolean; isPartial?: boolean }) {
			return new Text(formatResult(result, theme, context), 0, 0);
		},
	});

	// -----------------------------------------------------------------------
	// Tool: web_search
	// -----------------------------------------------------------------------

	pi.registerTool(withClaudeRows(defineTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using one of several backend search engines. " +
			"Supports Exa, Tavily, Firecrawl, Parallel, OpenAI Codex, and Grok. " +
			"The best available backend is used automatically. " +
			"Use for fact-finding, research, documentation lookups, and current events.",
		promptSnippet: "Search the web (supports multiple search backends)",
		promptGuidelines: [
			"Use web_search when you need up-to-date information, facts, or documentation from the web",
			"Auto mode tries enabled backends in order (Firecrawl is the free fallback)",
			"Set combine=true to query enabled backends in parallel and merge/deduplicate results",
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
			combine: Type.Optional(
				Type.Boolean({
					description: COMBINE_DESCRIPTION,
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
			const warnings: string[] = [];
			const onNotice = diagnostics.sink(ctx, warnings);
			refreshConfig(ctx.cwd, ctx.isProjectTrusted(), false, onNotice);
			const config = getConfig();
			const numResults = Math.max(1, Math.min(params.numResults ?? 10, 20));
			const combine = params.combine === true;
			const compact = params.compact ?? config.compact ?? false;
			const routing = routingOf(config);
			const effectiveness = routing === "best-latency" ? readEffectivenessState() : undefined;

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
				onNotice,
				modelRegistry: ctx.modelRegistry,
			});

			const activeBackends = getActiveBackends();
			const orderedBackends = filterQuotaSkipped(
				selectBackendsForFallback(routing, activeBackends, effectiveness),
				onNotice,
				Date.now(),
				(backend) => BACKEND_DEFS[backend]?.providerAuth
					? []
					: resolveBackendKeys(backend, config, onNotice),
			);

			if (combine) {
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
						...(warnings.length ? { warnings } : {}),
						resultCount: combined.length,
						usableBackendCount,
						backendStats: Object.fromEntries(backendStats),
					},
				};
			}

			const errors: string[] = [];
			for (const backend of orderedBackends) {
				const backendLabel = BACKEND_DEFS[backend]?.label || backend;
				updateActivity(`🔍 ${backendLabel}: searching...`);
				try {
					const results = withSource(backend, await runSearchBackend(backend, params.query, numResults, signal));
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
							...(warnings.length ? { warnings } : {}),
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
		},
	}), formatWebSearchCallLine, formatWebSearchResultLine));

	// -----------------------------------------------------------------------
	// Tool: web_read — Read/extract content from a URL
	// -----------------------------------------------------------------------

	pi.registerTool(withClaudeRows(defineTool({
		name: "web_read",
		label: "Read Web Page",
		description:
			"Fetch a URL as markdown. Search Hub tries Firecrawl, then Exa, then Parallel.",
		promptSnippet: "Read content from a web page (supports markdown extraction)",
		promptGuidelines: [
			"Use web_read when you need to read the content of a specific URL",
		],
		parameters: Type.Object({
			url: Type.String({
				description: "HTTP(S) URL or bare domain to fetch",
			}),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const warnings: string[] = [];
			const onNotice = diagnostics.sink(ctx, warnings);
			refreshConfig(ctx.cwd, ctx.isProjectTrusted(), false, onNotice);
			const config = getConfig();

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

			const readers = readerOrder();

			const fetchWithKeys = async (
				backend: ReaderName,
				required: boolean,
				fetchContent: (key?: string) => Promise<string>,
			): Promise<string> => {
				const keys = resolveBackendKeys(backend, config, onNotice);
				if (required && keys.length === 0) {
					throw new Error(`${READER_LABELS[backend]} reader selected but no API key configured. ${MISSING_KEY_HELP}`);
				}
				if (keys.length > 1) return withRotatedKeys(backend, keys, (key) => fetchContent(key));
				return fetchContent(keys[0]);
			};

			const fetchWithReader = async (reader: ReaderName): Promise<string> => {
				if (reader === "firecrawl") {
					return fetchWithKeys("firecrawl", false, async (key) => (
						await fetchFirecrawl(url, key, signal)
					).content);
				}
				if (reader === "exa") {
					return fetchWithKeys("exa", true, async (key) => (
						await fetchExaContents(url, key!, signal, onNotice)
					).content);
				}
				return fetchWithKeys("parallel", true, async (key) => (
					await fetchParallel(url, key!, signal)
				).content);
			};

			const errors: string[] = [];
			let content: string | undefined;
			let reader: ReaderName | undefined;
			for (const [index, candidate] of readers.entries()) {
				const label = READER_LABELS[candidate];
				updateActivity(`📄 ${label}: fetching...`, candidate);
				const started = Date.now();
				try {
					content = await fetchWithReader(candidate);
					await reportEffectiveness({
						backend: candidate,
						label,
						op: "read",
						ok: true,
						latencyMs: Date.now() - started,
						resultCount: content.length,
						onNotice,
					});
					reader = candidate;
					break;
				} catch (error) {
					await reportEffectiveness({
						backend: candidate,
						label,
						op: "read",
						ok: false,
						latencyMs: Date.now() - started,
						error,
						signal,
						onNotice,
					});
					if (signal?.aborted) throw error;
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
					...(warnings.length ? { warnings } : {}),
					url,
					reader,
					length: content.length,
					truncated: content.length > WEB_READ_RESULT_MAX_CHARS,
					fallbackErrors: errors.length > 0 ? errors : undefined,
				},
			};
		},
	}), formatWebReadCallLine, formatWebReadResultLine));

	pi.registerCommand("search-hub", {
		description: "Configure Search Hub or show the quota ledger",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "setup", label: "setup", description: "Routing, providers, and keys" },
				{ value: "status", label: "status", description: "Quota ledger" },
				{ value: "status refresh", label: "status refresh", description: "Refresh Tavily/Firecrawl usage" },
			];
			const needle = prefix.trim().toLowerCase();
			const filtered = options.filter((option) => option.value.startsWith(needle));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			let sub = tokens[0];
			if (!sub) {
				if (!ctx.hasUI || ctx.mode !== "tui") {
					ctx.ui.notify("Usage: /search-hub setup | status [refresh]", "info");
					return;
				}
				const choice = await ctx.ui.select("Search Hub", ["setup", "status"]);
				if (!choice) return;
				sub = choice;
			}
			if (sub === "setup") {
				await openSearchSetup(ctx);
				return;
			}
			if (sub === "status") {
				await openSearchStatus(ctx, tokens[1] === "refresh");
				return;
			}
			ctx.ui.notify("Usage: /search-hub setup | status [refresh]", "error");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		diagnostics.reset();
		clearCooldowns();
		refreshConfig(ctx.cwd, ctx.isProjectTrusted(), true, diagnostics.sink(ctx));
	});
}
