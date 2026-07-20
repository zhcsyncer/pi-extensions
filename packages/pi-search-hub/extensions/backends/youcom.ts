/**
 * You.com backend — web + news search, up to 100 results.
 * Endpoint: GET https://api.you.com/v1/search
 */

import { timeoutSignal, sanitizeError } from "../utils.js";
import { parseYoucom } from "../../backends/parsers.js";
import type { SearchResult } from "../types.js";

export async function searchYoucom(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[] }> {
	const params = new URLSearchParams({
		query,
		num_web_results: String(Math.min(numResults, 100)),
	});

	const response = await fetch(`https://api.you.com/v1/search?${params}`, {
		method: "GET",
		headers: {
			"X-API-Key": apiKey,
		},
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`You.com ${sanitizeError(response.status, text)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	return { results: parseYoucom(data, numResults) };
}
