import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { searchLibraries } from "../api.ts";
import { formatSearchResults } from "../format.ts";
import {
  renderResolveCall,
  renderResolveResult,
} from "../render.ts";
import { toToolResult } from "../result.ts";
import type { ResolveLibraryIdDetails } from "../types.ts";
import {
  RESOLVE_LIBRARY_ID_TITLE,
  RESOLVE_LIBRARY_ID_DESCRIPTION,
  RESOLVE_LIBRARY_ID_QUERY_DESCRIPTION,
  RESOLVE_LIBRARY_ID_LIBRARY_NAME_DESCRIPTION,
} from "../prompts.ts";

const Params = Type.Object({
  query: Type.String({ description: RESOLVE_LIBRARY_ID_QUERY_DESCRIPTION }),
  libraryName: Type.String({ description: RESOLVE_LIBRARY_ID_LIBRARY_NAME_DESCRIPTION }),
});

export const resolveLibraryIdTool: ToolDefinition<typeof Params, ResolveLibraryIdDetails> = {
  name: "resolve-library-id",
  label: RESOLVE_LIBRARY_ID_TITLE,
  description: RESOLVE_LIBRARY_ID_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
    signal: AbortSignal | undefined,
  ) {
    const searchResponse = await searchLibraries(params.query, params.libraryName, signal);
    if (!searchResponse.results || searchResponse.results.length === 0) {
      return toToolResult(
        searchResponse.error ?? "No libraries found matching the provided name.",
        {
          kind: "resolve",
          candidateCount: 0,
        },
      );
    }
    return toToolResult(`Available Libraries:\n\n${formatSearchResults(searchResponse)}`, {
      kind: "resolve",
      candidateCount: searchResponse.results.length,
      topLibraryId: searchResponse.results[0]?.id,
    });
  },
  renderCall(args, theme) {
    return renderResolveCall(args, theme);
  },
  renderResult(result, options, theme, context) {
    return renderResolveResult(result, options, theme, context);
  },
};
