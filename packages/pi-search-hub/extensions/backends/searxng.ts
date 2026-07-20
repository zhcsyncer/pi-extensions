/**
 * SearXNG backend — self-hosted metasearch, aggregates 70+ providers.
 * Needs instance URL configured in search.json.
 */

import { timeoutSignal, sanitizeError } from "../utils.js";
import { parseSearXNG } from "../../backends/parsers.js";
import type { SearchResult } from "../types.js";

export async function searchSearXNG(
	query: string,
	numResults: number,
	apiKey: string | undefined,
	instanceUrl: string | undefined,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[] }> {
	if (!instanceUrl) {
		throw new Error("SearXNG instance URL not configured. Set searxng.instanceUrl in search.json (e.g. http://localhost:8888)");
	}

	const baseUrl = instanceUrl.replace(/\/+$/, "");
	const params = new URLSearchParams({
		q: query,
		format: "json",
		count: String(Math.min(numResults, 50)),
	});

	const headers: Record<string, string> = {
		"Accept": "application/json",
	};
	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`;
	}

	const response = await fetch(`${baseUrl}/search?${params}`, {
		method: "GET",
		headers,
		signal: timeoutSignal(signal),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`SearXNG ${sanitizeError(response.status, text)}`);
	}

	const data = (await response.json()) as Record<string, unknown>;
	return { results: parseSearXNG(data, numResults) };
}
