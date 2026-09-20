/**
 * Hosted web_search via Pi's modelRegistry.complete().
 * Codex and Grok are inference calls with a server-side search tool, not SERP APIs.
 */

import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { NoticeSink } from "../diagnostics.js";
import type { HostedSearchRuntime, SearchResult } from "../types.js";
import { timeoutSignal } from "../utils.js";

export const HOSTED_SEARCH_BACKENDS = {
	"openai-codex": {
		provider: "openai-codex",
		login: "openai-codex",
		label: "OpenAI Codex",
		defaultModel: "gpt-5.6-luna",
		flavor: "codex",
	},
	xai: {
		provider: "xai",
		login: "xai",
		label: "Grok",
		defaultModel: "grok-4.3",
		flavor: "xai",
	},
} as const;

export type HostedSearchBackendName = keyof typeof HOSTED_SEARCH_BACKENDS;
export type HostedSearchFlavor = (typeof HOSTED_SEARCH_BACKENDS)[HostedSearchBackendName]["flavor"];

const MAX_TOOL_RESULTS = 20;
const MAX_TITLE_LENGTH = 200;
const MAX_SNIPPET_LENGTH = 1000;
const DEFAULT_SEARCH_CONTEXT_SIZE = "low";

const SUBMIT_SEARCH_RESULTS_TOOL = {
	name: "submit_search_results",
	description: "Submit structured search results based on the available source evidence.",
	parameters: Type.Object({
		results: Type.Array(
			Type.Object({
				title: Type.String({
					description: "Page title or clearest source title for the URL.",
				}),
				url: Type.String({
					description: "Canonical http/https URL for the result.",
				}),
				snippet: Type.String({
					description:
						"A dense 450-500 character, multi-sentence paragraph with the most query-relevant facts, claims, numbers, dates, caveats, scope limits, and source-specific details from the available source evidence. Prefer completeness and concrete details over brevity while staying within normal search-result display. Shorter is acceptable only when evidence is thin. Do not write an opinion about usefulness.",
				}),
			}),
			{ maxItems: MAX_TOOL_RESULTS },
		),
	}),
} as const;

export function isHostedSearchBackend(name: string): name is HostedSearchBackendName {
	return name in HOSTED_SEARCH_BACKENDS;
}

export function hostedSearchModelIds(
	runtime: Pick<HostedSearchRuntime, "getProvider"> | undefined,
	backend: HostedSearchBackendName,
): string[] {
	const spec = HOSTED_SEARCH_BACKENDS[backend];
	const ids = runtime?.getProvider?.(spec.provider)?.getModels().map((model) => model.id) ?? [];
	if (ids.length === 0) return [spec.defaultModel];
	if (ids.includes(spec.defaultModel)) {
		return [spec.defaultModel, ...ids.filter((id) => id !== spec.defaultModel)];
	}
	return ids;
}

export function resolveHostedSearchModel(
	runtime: HostedSearchRuntime,
	backend: HostedSearchBackendName,
	requested: string | undefined,
	onNotice?: NoticeSink,
): Model<Api> {
	const spec = HOSTED_SEARCH_BACKENDS[backend];
	const requestedId = requested?.trim();
	if (requestedId) {
		const found = runtime.find(spec.provider, requestedId) as Model<Api> | undefined;
		if (found) return found;
		onNotice?.(
			`Search Hub ${spec.label}: unknown model "${requestedId}", using ${spec.defaultModel}.`,
		);
	}
	const fallback = (runtime.find(spec.provider, spec.defaultModel) as Model<Api> | undefined)
		?? (runtime.getProvider?.(spec.provider)?.getModels()[0] as Model<Api> | undefined);
	if (fallback) return fallback;
	throw new Error(`${spec.label} model not found: ${spec.defaultModel}`);
}

export async function searchHostedWebSearch(
	backend: HostedSearchBackendName,
	query: string,
	numResults: number,
	runtime: HostedSearchRuntime | undefined,
	signal?: AbortSignal,
	modelId?: string,
	timeoutMs?: number,
	onNotice?: NoticeSink,
): Promise<{ results: SearchResult[] }> {
	const spec = HOSTED_SEARCH_BACKENDS[backend];
	if (signal?.aborted) {
		throw new Error(`${spec.label} search cancelled`);
	}
	if (!runtime) {
		throw new Error(`${spec.label} authentication not found. Run /login ${spec.login}.`);
	}

	const model = resolveHostedSearchModel(runtime, backend, modelId, onNotice);
	if (runtime.hasConfiguredAuth && !runtime.hasConfiguredAuth(model)) {
		throw new Error(`${spec.label} authentication not found. Run /login ${spec.login}.`);
	}

	const context: Context = {
		systemPrompt: buildSystemPrompt(numResults),
		messages: [
			{
				role: "user",
				content: query,
				timestamp: Date.now(),
			},
		],
		tools: [SUBMIT_SEARCH_RESULTS_TOOL],
	};

	const options: Record<string, unknown> = {
		signal: timeoutSignal(signal, timeoutMs),
		onPayload: (payload: unknown) => injectHostedWebSearch(payload, spec.flavor),
	};
	if (spec.flavor === "codex") {
		options.reasoningEffort = "minimal";
		options.textVerbosity = "low";
	}

	let message: AssistantMessage;
	try {
		message = await runtime.complete(model, context, options) as AssistantMessage;
	} catch (error) {
		throw hostedAuthError(spec, error);
	}

	if (message.stopReason === "error") {
		throw hostedAuthError(spec, new Error(message.errorMessage || `${spec.label} search failed`));
	}
	if (message.stopReason === "aborted") {
		throw new Error(`${spec.label} search cancelled`);
	}

	const submitCall = message.content.find(
		(block) => block.type === "toolCall" && block.name === "submit_search_results",
	);
	if (!submitCall || submitCall.type !== "toolCall") {
		throw new Error(`${spec.label} search did not submit structured results`);
	}

	const results = normalizeSubmitSearchResults(submitCall.arguments, numResults);
	if (results.length === 0) {
		throw new Error(`${spec.label} search returned no valid URL results`);
	}
	return { results };
}

function hostedAuthError(
	spec: (typeof HOSTED_SEARCH_BACKENDS)[HostedSearchBackendName],
	error: unknown,
): Error {
	const message = error instanceof Error ? error.message : String(error);
	if (/not configured|No API key|authentication not found/i.test(message)) {
		return new Error(`${spec.label} authentication not found. Run /login ${spec.login}.`);
	}
	return error instanceof Error ? error : new Error(message);
}

function buildSystemPrompt(numResults: number): string {
	return [
		`Research the user's query with hosted web_search and call submit_search_results exactly once with at most ${numResults} results.`,
		"Return only real http/https URLs.",
		"Prefer primary sources.",
		"For snippet, write a dense 450-500 character, multi-sentence paragraph with the most query-relevant facts, claims, numbers, dates, caveats, scope limits, and source-specific details from the available source evidence. Prefer completeness and concrete details over brevity while staying within normal search-result display. Shorter is acceptable only when evidence is thin.",
		"Do not invent details or present unsupported text as source content.",
		"No prose.",
		"No internal references.",
	].join(" ");
}

export function injectHostedWebSearch(payload: unknown, flavor: HostedSearchFlavor): unknown {
	const body = isRecord(payload) ? payload : {};
	const existingTools = Array.isArray(body.tools) ? body.tools.filter(Boolean) : [];
	const filteredTools = existingTools.filter((tool) => {
		if (!isRecord(tool)) return true;
		return tool.type !== "web_search";
	});
	const hostedTool = flavor === "codex"
		? {
			type: "web_search",
			external_web_access: true,
			search_context_size: DEFAULT_SEARCH_CONTEXT_SIZE,
		}
		: { type: "web_search" };

	body.tools = [hostedTool, ...filteredTools];
	body.tool_choice = "auto";
	body.parallel_tool_calls = false;

	if (flavor === "codex") {
		const include = Array.isArray(body.include)
			? body.include.filter((value): value is string => typeof value === "string")
			: [];
		body.include = Array.from(new Set([...include, "web_search_call.action.sources"]));
	}

	return body;
}

export function normalizeSubmitSearchResults(args: unknown, numResults: number): SearchResult[] {
	if (!isRecord(args) || !Array.isArray(args.results)) {
		return [];
	}

	const limit = Math.max(1, Math.min(numResults, MAX_TOOL_RESULTS));
	const deduped = new Set<string>();
	const results: SearchResult[] = [];

	for (const rawResult of args.results) {
		const normalized = normalizeSearchResult(rawResult);
		if (!normalized) continue;

		const dedupeKey = normalizeUrlForDedup(normalized.url);
		if (deduped.has(dedupeKey)) continue;

		deduped.add(dedupeKey);
		results.push(normalized);
		if (results.length >= limit) break;
	}

	return results;
}

export function normalizeSearchResult(rawResult: unknown): SearchResult | null {
	if (!isRecord(rawResult)) return null;

	const url = normalizeHttpUrl(rawResult.url);
	if (!url) return null;

	const fallbackTitle = safeUrlHostname(url);
	const title = truncateText(cleanString(rawResult.title) || fallbackTitle, MAX_TITLE_LENGTH);
	const snippet = truncateText(cleanString(rawResult.snippet), MAX_SNIPPET_LENGTH);
	const content = truncateText(cleanString(rawResult.content), MAX_SNIPPET_LENGTH);
	const display = snippet || content;
	if (!display) return null;

	return {
		title,
		url,
		snippet: display,
		content: display,
	};
}

export function normalizeHttpUrl(value: unknown): string | undefined {
	const input = cleanString(value);
	if (!input) return undefined;

	const candidate = hasUrlScheme(input)
		? input
		: looksLikeDomainOrPath(input)
			? `https://${input}`
			: input;

	try {
		const url = new URL(candidate);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return undefined;
		}
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

export function normalizeUrlForDedup(url: string): string {
	try {
		const normalized = new URL(url);
		normalized.hash = "";
		normalized.pathname = normalized.pathname.replace(/\/+$/, "") || "/";
		return normalized.toString().toLowerCase();
	} catch {
		return url.trim().toLowerCase();
	}
}

export function looksLikeDomainOrPath(value: string): boolean {
	return /^[^\s/]+\.[^\s]+(?:\/.*)?$/.test(value);
}

function safeUrlHostname(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

function cleanString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function truncateText(value: string, maxLength: number): string {
	return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function hasUrlScheme(value: string): boolean {
	return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
