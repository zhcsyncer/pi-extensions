/**
 * Brave LLM Context backend — pre-extracted AI-grounding chunks.
 * Uses same API key as Brave Search (X-Subscription-Token).
 * Endpoint: POST https://api.search.brave.com/app/v1/llm/context
 */

import { timeoutSignal, sanitizeError } from "../utils.js";
import { parseBraveLLM } from "../../backends/parsers.js";
import type { SearchResult } from "../types.js";

export async function searchBraveLLM(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
	tokenBudget?: number,
): Promise<{ results: SearchResult[] }> {
	const body: Record<string, unknown> = { query };
	if (tokenBudget) body.token_budget = tokenBudget;

	const response = await fetch("https://api.search.brave.com/app/v1/llm/context", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Accept": "application/json",
			"X-Subscription-Token": apiKey,
		},
		body: JSON.stringify(body),
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Brave LLM ${sanitizeError(response.status, text)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	return { results: parseBraveLLM(data, numResults) };
}
