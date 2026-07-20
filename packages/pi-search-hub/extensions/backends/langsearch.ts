/**
 * LangSearch backend — genuinely free tier, needs API key.
 */

import { timeoutSignal, sanitizeError } from "../utils.js";
import { parseLangSearch } from "../../backends/parsers.js";
import type { SearchResult } from "../types.js";

export async function searchLangSearch(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[] }> {
	const body = { query, max_results: Math.min(numResults, 20) };
	const response = await fetch("https://api.langsearch.com/v1/web-search", {
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
		throw new Error(`LangSearch ${sanitizeError(response.status, text)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	return { results: parseLangSearch(data, numResults) };
}
