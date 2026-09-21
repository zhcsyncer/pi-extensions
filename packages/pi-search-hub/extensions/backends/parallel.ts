/**
 * Parallel backend — official REST search + extract. API key required.
 * Docs: https://docs.parallel.ai/api-reference/search/search
 */

import { timeoutSignal, sanitizeError } from "../utils.js";
import { parseParallel } from "../../backends/parsers.js";
import type { SearchResult } from "../types.js";

const SEARCH_URL = "https://api.parallel.ai/v1/search";
const EXTRACT_URL = "https://api.parallel.ai/v1/extract";

function parallelHeaders(apiKey: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"x-api-key": apiKey,
	};
}

function errorDetail(text: string): string {
	try {
		const json = JSON.parse(text) as Record<string, unknown>;
		const nested = json.error;
		if (typeof nested === "string") return nested;
		if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).message === "string") {
			return (nested as Record<string, unknown>).message as string;
		}
		if (typeof json.message === "string") return json.message;
	} catch {
		// use raw
	}
	return text;
}

export async function searchParallel(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[] }> {
	const response = await fetch(SEARCH_URL, {
		method: "POST",
		headers: parallelHeaders(apiKey),
		body: JSON.stringify({
			objective: query,
			search_queries: [query],
			mode: "fast",
		}),
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Parallel ${sanitizeError(response.status, errorDetail(text))}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	return { results: parseParallel(data, numResults) };
}

export async function fetchParallel(
	url: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ title: string; url: string; content: string }> {
	const response = await fetch(EXTRACT_URL, {
		method: "POST",
		headers: parallelHeaders(apiKey),
		body: JSON.stringify({
			urls: [url],
			full_content: true,
		}),
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Parallel extract ${sanitizeError(response.status, errorDetail(text))}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	const results = Array.isArray(data.results)
		? (data.results as Array<Record<string, unknown>>)
		: [];
	const first = results[0];
	if (!first) {
		const errors = Array.isArray(data.errors) ? data.errors as Array<Record<string, unknown>> : [];
		const firstError = errors[0];
		const detail = typeof firstError?.content === "string"
			? firstError.content
			: typeof firstError?.error_type === "string"
				? firstError.error_type
				: "no results";
		throw new Error(`Parallel extract returned no content for ${url}: ${detail}`);
	}
	const fullContent = typeof first.full_content === "string" ? first.full_content : "";
	const excerpts = Array.isArray(first.excerpts)
		? first.excerpts.filter((entry): entry is string => typeof entry === "string")
		: [];
	const content = fullContent || excerpts.join("\n\n");
	return {
		title: (first.title as string) || "",
		url: (first.url as string) || url,
		content,
	};
}
