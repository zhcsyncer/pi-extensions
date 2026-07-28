// Copied verbatim from @upstash/context7-mcp (packages/mcp/src/lib/types.ts)
// to keep pi's wire format in lockstep with MCP. Update both together.

export interface SearchResult {
  id: string;
  title: string;
  description: string;
  branch: string;
  lastUpdateDate: string;
  state: DocumentState;
  totalTokens: number;
  totalSnippets: number;
  stars?: number;
  trustScore?: number;
  benchmarkScore?: number;
  versions?: string[];
  source?: string;
}

export interface SearchResponse {
  error?: string;
  results: SearchResult[];
  searchFilterApplied?: boolean;
}

export type DocumentState = "initial" | "finalized" | "error" | "delete";

/** Minimal render metadata for resolve-library-id. Do not store full API payloads. */
export interface ResolveLibraryIdDetails {
  kind: "resolve";
  candidateCount: number;
  topLibraryId?: string;
}

/** Minimal render metadata for query-docs. Do not store full documentation text. */
export interface QueryDocsDetails {
  kind: "query";
  byteLength: number;
  lineCount: number;
}

export type Context7ToolDetails = ResolveLibraryIdDetails | QueryDocsDetails;
