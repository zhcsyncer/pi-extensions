import {
  getMarkdownTheme,
  keyHint,
  type AgentToolResult,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text, type Component } from "@earendil-works/pi-tui";
import { formatByteSize, measureText, textContent } from "./result.ts";
import type { QueryDocsDetails, ResolveLibraryIdDetails } from "./types.ts";

function renderExpandedMarkdown(content: string): Component {
  return new Markdown(content, 0, 0, getMarkdownTheme());
}

function expandHint(): string {
  try {
    const styled = keyHint("app.tools.expand", "to expand");
    const plain = styled.replace(/\x1b\[[0-9;]*m/g, "").trim();
    // keyHint keeps the description even when no key text is bound yet.
    if (!plain || plain === "to expand") {
      return "Ctrl+O to expand";
    }
    return plain;
  } catch {
    return "Ctrl+O to expand";
  }
}

function firstLine(text: string, fallback: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0]?.trim();
  return line || fallback;
}

export function resolveDetailsFromResult(
  result: AgentToolResult<unknown>,
): ResolveLibraryIdDetails {
  const details = result.details as ResolveLibraryIdDetails | null | undefined;
  if (details && details.kind === "resolve" && typeof details.candidateCount === "number") {
    return {
      kind: "resolve",
      candidateCount: details.candidateCount,
      topLibraryId:
        typeof details.topLibraryId === "string" && details.topLibraryId.length > 0
          ? details.topLibraryId
          : undefined,
    };
  }

  const text = textContent(result);
  const ids = [...text.matchAll(/Context7-compatible library ID:\s*(\S+)/g)].map(
    (match) => match[1]!,
  );
  return {
    kind: "resolve",
    candidateCount: ids.length,
    topLibraryId: ids[0],
  };
}

export function queryDetailsFromResult(result: AgentToolResult<unknown>): QueryDocsDetails {
  const details = result.details as QueryDocsDetails | null | undefined;
  if (
    details &&
    details.kind === "query" &&
    typeof details.byteLength === "number" &&
    typeof details.lineCount === "number"
  ) {
    return {
      kind: "query",
      byteLength: details.byteLength,
      lineCount: details.lineCount,
    };
  }

  const measured = measureText(textContent(result));
  return {
    kind: "query",
    byteLength: measured.byteLength,
    lineCount: measured.lineCount,
  };
}

export function renderResolveCall(
  args: { libraryName?: string },
  theme: Theme,
): Component {
  let text = theme.fg("toolTitle", theme.bold("Context7 Resolve"));
  if (typeof args.libraryName === "string" && args.libraryName.length > 0) {
    text += ` ${theme.fg("accent", args.libraryName)}`;
  }
  return new Text(text, 0, 0);
}

export function renderQueryCall(
  args: { libraryId?: string },
  theme: Theme,
): Component {
  let text = theme.fg("toolTitle", theme.bold("Context7 Query"));
  if (typeof args.libraryId === "string" && args.libraryId.length > 0) {
    text += ` ${theme.fg("accent", args.libraryId)}`;
  }
  return new Text(text, 0, 0);
}

export function renderResolveResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: { isError?: boolean },
): Component {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "Resolving..."), 0, 0);
  }

  const content = textContent(result);
  if (context.isError) {
    return new Text(theme.fg("error", `✗ ${firstLine(content, "Request failed")}`), 0, 0);
  }

  if (options.expanded) {
    return renderExpandedMarkdown(content);
  }

  const details = resolveDetailsFromResult(result);
  const countLabel =
    details.candidateCount === 1
      ? "1 candidate"
      : `${details.candidateCount} candidates`;
  let body = countLabel;
  if (details.topLibraryId) {
    body += ` · top ${details.topLibraryId}`;
  }
  body += ` (${expandHint()})`;
  const summary = `${theme.fg("success", "✓")} ${theme.fg("dim", body)}`;
  return new Text(summary, 0, 0);
}

export function renderQueryResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: { isError?: boolean },
): Component {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "Querying..."), 0, 0);
  }

  const content = textContent(result);
  if (context.isError) {
    return new Text(theme.fg("error", `✗ ${firstLine(content, "Request failed")}`), 0, 0);
  }

  if (options.expanded) {
    return renderExpandedMarkdown(content);
  }

  const details = queryDetailsFromResult(result);
  const lineLabel = details.lineCount === 1 ? "1 line" : `${details.lineCount} lines`;
  const summary =
    `${theme.fg("success", "✓")} ` +
    theme.fg(
      "dim",
      `${formatByteSize(details.byteLength)} · ${lineLabel} (${expandHint()})`,
    );
  return new Text(summary, 0, 0);
}
