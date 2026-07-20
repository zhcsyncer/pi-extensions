/**
 * Serper.dev backend — Google search, needs API key.
 */

import { timeoutSignal, sanitizeError } from "../utils.js";
import { parseSerper } from "../../backends/parsers.js";
import type { SearchResult } from "../types.js";

export async function searchSerper(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[] }> {
	const body = { q: query, num: Math.min(numResults, 100) };
	const response = await fetch("https://google.serper.dev/search", {
		method: "POST",
		headers: {
			"X-API-KEY": apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Serper ${sanitizeError(response.status, text)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	return { results: parseSerper(data, numResults) };
}
