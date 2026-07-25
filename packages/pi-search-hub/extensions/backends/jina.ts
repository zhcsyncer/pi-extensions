/**
 * Jina AI backend — search via s.jina.ai with anonymous access or an optional API key.
 * Authenticated requests receive higher quotas; web_read uses the separate r.jina.ai Reader endpoint.
 */

import { timeoutSignal, sanitizeError } from "../utils.js";
import { parseJina } from "../../backends/parsers.js";
import type { SearchResult } from "../types.js";

export async function searchJina(
	query: string,
	numResults: number,
	apiKey?: string,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[] }> {
	const url = `https://s.jina.ai/?q=${encodeURIComponent(query)}&format=json`;
	const headers: Record<string, string> = {
		"Accept": "application/json",
	};
	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`;
	}
	const response = await fetch(url, {
		signal: timeoutSignal(signal),
		headers,
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Jina AI ${sanitizeError(response.status, text)}`);
	}

	const data = (await response.json()) as Record<string, unknown>;
	return { results: parseJina(data, numResults) };
}
