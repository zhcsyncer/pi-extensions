/**
 * Pure response parsers for search backends.
 * Each takes raw JSON data and returns normalized results.
 * No HTTP, no side effects — easy to unit test.
 */

export interface ParsedResult {
	title: string;
	url: string;
	snippet: string;
}

// ---------------------------------------------------------------------------
// Tavily
// Response: { results: [{ title, url, content }] }
// ---------------------------------------------------------------------------

export interface TavilyParsedResult extends ParsedResult {
	content?: string;
}

export function parseTavily(
	data: Record<string, unknown>,
	numResults: number,
): TavilyParsedResult[] {
	const rawResults = data.results;
	const results = Array.isArray(rawResults) ? rawResults : [];
	return results.slice(0, numResults).map((r) => ({
		title: (r.title as string) || "",
		url: (r.url as string) || "",
		snippet: (r.content as string) || "",
		content: r.content as string,
	}));
}

// ---------------------------------------------------------------------------
// Exa
// Response: { results: [{ title, url, text, highlight }] }
// ---------------------------------------------------------------------------

export function parseExa(
	data: Record<string, unknown>,
	numResults: number,
): ParsedResult[] {
	const rawResults = data.results;
	const results = Array.isArray(rawResults) ? rawResults : [];
	return results.slice(0, numResults).map((r) => ({
		title: (r.title as string) || "",
		url: (r.url as string) || "",
		snippet: ((r.text as string) || (r.highlight as string) || "").slice(0, 500),
	}));
}

// ---------------------------------------------------------------------------
// Firecrawl v2
// Response: { data: { web: [...] } or data: [...] or { results: [...] } (v1 fallback)
// ---------------------------------------------------------------------------

export function parseFirecrawl(
	data: Record<string, unknown>,
	numResults: number,
): ParsedResult[] {
	const rawData = data.data;
	let results: Array<Record<string, unknown>> = [];
	if (Array.isArray(rawData)) {
		results = rawData;
	} else if (typeof rawData === "object" && rawData !== null) {
		const obj = rawData as Record<string, unknown>;
		results = Array.isArray(obj.web) ? obj.web : [];
		if (results.length === 0) {
			if (Array.isArray(obj.images)) results = obj.images as Array<Record<string, unknown>>;
			else if (Array.isArray(obj.news)) results = obj.news as Array<Record<string, unknown>>;
		}
	} else if (Array.isArray(data.results)) {
		results = data.results;
	}
	return results.slice(0, numResults).map((r) => ({
		title: (r.title as string) || "",
		url: (r.url as string) || "",
		snippet: ((r.description as string) || (r.snippet as string) || "").slice(0, 500),
	}));
}

// ---------------------------------------------------------------------------
// Parallel
// Response: { results: [{ title, url, excerpts: string[] }] }
// ---------------------------------------------------------------------------

export function parseParallel(
	data: Record<string, unknown>,
	numResults: number,
): ParsedResult[] {
	const rawResults = data.results;
	const results = Array.isArray(rawResults) ? rawResults : [];
	return results.slice(0, numResults).map((r) => {
		const excerpts = Array.isArray(r.excerpts)
			? r.excerpts.filter((entry: unknown): entry is string => typeof entry === "string")
			: [];
		return {
			title: (r.title as string) || "",
			url: (r.url as string) || "",
			snippet: excerpts.join(" ").slice(0, 500),
		};
	});
}
