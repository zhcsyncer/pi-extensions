/**
 * WebSearchAPI.ai backend — Google-powered, needs API key.
 */

import { timeoutSignal, sanitizeError } from "../utils.js";
import { parseWebSearchAPI } from "../../backends/parsers.js";
import type { SearchResult } from "../types.js";

export async function searchWebSearchAPI(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[] }> {
	const body = {
		query,
		maxResults: Math.min(numResults, 20),
		includeContent: false,
		country: "us",
		language: "en",
	};
	const response = await fetch("https://api.websearchapi.ai/ai-search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`WebSearchAPI ${sanitizeError(response.status, text)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	return { results: parseWebSearchAPI(data, numResults) };
}
