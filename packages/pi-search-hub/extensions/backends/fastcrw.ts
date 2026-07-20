/**
 * fastCRW backend — Firecrawl-compatible search + scrape.
 * Cloud: https://api.fastcrw.com — or self-hosted.
 * Endpoint: POST /v1/search (Firecrawl-compatible)
 */

import { timeoutSignal, sanitizeError } from "../utils.js";
import { parseFastcrw } from "../../backends/parsers.js";
import type { SearchResult } from "../types.js";

export async function searchFastcrw(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
	baseUrl?: string,
): Promise<{ results: SearchResult[] }> {
	const url = `${baseUrl || "https://api.fastcrw.com"}/v1/search`;
	const body = { query, limit: Math.min(numResults, 20) };

	const response = await fetch(url, {
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
		throw new Error(`fastCRW ${sanitizeError(response.status, text)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	return { results: parseFastcrw(data, numResults) };
}
