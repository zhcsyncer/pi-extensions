import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { fetchLibraryContext } from "../api.ts";
import {
  renderQueryCall,
  renderQueryResult,
} from "../render.ts";
import { measureText, toToolResult } from "../result.ts";
import type { QueryDocsDetails } from "../types.ts";
import {
  QUERY_DOCS_TITLE,
  QUERY_DOCS_DESCRIPTION,
  QUERY_DOCS_LIBRARY_ID_DESCRIPTION,
  QUERY_DOCS_QUERY_DESCRIPTION,
} from "../prompts.ts";

const Params = Type.Object({
  libraryId: Type.String({ description: QUERY_DOCS_LIBRARY_ID_DESCRIPTION }),
  query: Type.String({ description: QUERY_DOCS_QUERY_DESCRIPTION }),
});

export const queryDocsTool: ToolDefinition<typeof Params, QueryDocsDetails> = {
  name: "query-docs",
  label: QUERY_DOCS_TITLE,
  description: QUERY_DOCS_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
    signal: AbortSignal | undefined,
  ) {
    const text = await fetchLibraryContext(params.query, params.libraryId, signal);
    const measured = measureText(text);
    return toToolResult(text, {
      kind: "query",
      byteLength: measured.byteLength,
      lineCount: measured.lineCount,
    });
  },
  renderCall(args, theme) {
    return renderQueryCall(args, theme);
  },
  renderResult(result, options, theme, context) {
    return renderQueryResult(result, options, theme, context);
  },
};
