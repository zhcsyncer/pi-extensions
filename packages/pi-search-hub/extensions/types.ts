/**
 * Shared types for pi-search-hub extension.
 */

export const SEARCH_BACKEND_NAMES = ["exa", "tavily", "firecrawl", "parallel"] as const;
export type SearchBackendName = (typeof SEARCH_BACKEND_NAMES)[number];

export const READER_NAMES = ["firecrawl", "exa", "parallel"] as const;
export type ReaderName = (typeof READER_NAMES)[number];

export const DEFAULT_READER = "firecrawl";
export const KEYLESS_FALLBACK_BACKEND = "firecrawl";
export const ROUTING_STRATEGIES = ["priority", "random", "best-latency"] as const;
export type RoutingStrategy = (typeof ROUTING_STRATEGIES)[number];
export const DEFAULT_ROUTING: RoutingStrategy = "priority";

export function isSearchBackendName(value: unknown): value is SearchBackendName {
	return typeof value === "string" && (SEARCH_BACKEND_NAMES as readonly string[]).includes(value);
}

export function isReaderName(value: unknown): value is ReaderName {
	return typeof value === "string" && (READER_NAMES as readonly string[]).includes(value);
}

export function isRoutingStrategy(value: unknown): value is RoutingStrategy {
	return typeof value === "string" && (ROUTING_STRATEGIES as readonly string[]).includes(value);
}

export interface BackendConfig {
	enabled?: boolean;
	/** Legacy single-key field. Normalized into `apiKeys` on load/save. */
	apiKey?: string;
	apiKeys?: string[];
	/** Per-backend timeout override in milliseconds. Default: 30000 */
	timeout?: number;
	/** Per-backend max results override. Default: 10 */
	maxResults?: number;
	/** Per-backend extra headers */
	headers?: Record<string, string>;
}

export interface SearchConfig {
	/** Try-order for fallback and targeted combine. Default: priority. */
	routing?: RoutingStrategy;
	/** Enabled backends in try order. Ignored names and disabled backends are dropped at use/save. */
	priority?: SearchBackendName[];
	/** Default compact output. When true, returns single-line results (title + URL). Default: false. */
	compact?: boolean;
	backends?: {
		exa?: BackendConfig;
		tavily?: BackendConfig;
		firecrawl?: BackendConfig;
		parallel?: BackendConfig;
	};
}

export interface SearchResult {
	title: string;
	url: string;
	snippet?: string;
	content?: string;
}

export interface SearchResultWithBackend extends SearchResult {
	backend?: string;
}

export interface BackendRunner {
	needsKey: boolean;
	optionalKey: boolean;
	label: string;
	setupLabel: string | null;
	search: (
		query: string,
		numResults: number,
		deps: { key?: string; signal?: AbortSignal; backendConfig?: BackendConfig; onNotice?: (message: string) => void },
	) => Promise<{ results: SearchResult[]; warning?: string }>;
}
