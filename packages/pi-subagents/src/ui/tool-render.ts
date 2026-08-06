/**
 * tool-render.ts — Shared collapsed/expanded TUI helpers for subagent tools.
 *
 * Without a custom renderResult, Pi dumps the full tool content and ignores the
 * transcript expand toggle — get_subagent_result was the worst offender.
 *
 * Expanded bodies use Markdown (same path as pi-context7); collapsed stays a
 * one-line preview so the main TUI stays scannable.
 */

import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, type Component } from "@earendil-works/pi-tui";
import type { AgentDetails, Theme } from "./agent-widget.js";
import { fgPreservingNestedStyles, formatMs, formatTurns, SPINNER } from "./agent-widget.js";

/** Collapsed preview: first non-empty line, hard-capped. */
export const RESULT_COLLAPSED_PREVIEW_CHARS = 100;

export type TextResultLike = {
  content?: Array<{ type?: string; text?: string }>;
  details?: unknown;
};

/** Join text blocks from a tool result. */
export function toolResultText(result: TextResultLike): string {
  if (!result.content?.length) return "";
  return result.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text ?? "")
    .join("\n");
}

/** First non-empty line, collapsed to a single visual line. */
export function firstLinePreview(text: string, maxChars = RESULT_COLLAPSED_PREVIEW_CHARS): string {
  const line =
    text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const one = line.replace(/\s+/g, " ");
  if (one.length <= maxChars) return one;
  if (maxChars <= 1) return "…";
  return `${one.slice(0, maxChars - 1)}…`;
}

/**
 * True when the first `\n\n`-delimited block looks like our tool status header
 * (safe to peel). Plain multi-paragraph errors must NOT match.
 */
export function looksLikeStatusHeader(block: string): boolean {
  const head = block.replace(/\r\n/g, "\n").trim();
  if (!head) return false;
  if (/^Agent completed in \d/i.test(head)) return true;
  if (/^Agent failed:/i.test(head)) return true;
  if (/^Note: Unknown agent type/i.test(head)) return true;
  // get_subagent_result / background spawn multi-line meta block
  if (/^Agent:\s+\S+/m.test(head) && /^Type:\s+/m.test(head)) return true;
  if (/^Agent (queued|started) in background/i.test(head)) return true;
  return false;
}

/**
 * Prefer the body after a recognized status header; otherwise keep full text.
 * Prevents multi-paragraph errors like "Model not in scope…\n\nAllowed…" from
 * losing their first (most important) paragraph in previews.
 */
export function resultBodyText(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";
  const parts = normalized.split(/\n\n+/);
  if (parts.length >= 2 && looksLikeStatusHeader(parts[0] ?? "")) {
    const body = parts.slice(1).join("\n\n").trim();
    if (body) return body;
  }
  return normalized;
}

/** Expand-key hint, matching pi-context7. */
export function expandHint(): string {
  try {
    const styled = keyHint("app.tools.expand", "to expand");
    const plain = styled.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!plain || plain === "to expand") return "Ctrl+O to expand";
    return plain;
  } catch {
    return "Ctrl+O to expand";
  }
}

export function renderExpandedMarkdown(content: string): Component {
  return new Markdown(content, 0, 0, getMarkdownTheme());
}

export function appendCollapsedPreviewLine(
  base: string,
  text: string,
  theme: Pick<Theme, "fg">,
  emptyLabel: string,
  opts?: { withExpandHint?: boolean; previewColor?: string },
): string {
  const preview = firstLinePreview(resultBodyText(text));
  const label = preview || emptyLabel;
  const hint = opts?.withExpandHint === false ? "" : ` (${expandHint()})`;
  const color = opts?.previewColor ?? "dim";
  return base + "\n" + theme.fg(color, `  ⎿  ${label}${hint}`);
}

/** Build "haiku · ↻5≤30 · 3 tool uses · 33.8k token" stats fragment. */
export function formatAgentDetailsStats(d: AgentDetails, theme: Theme): string {
  const parts: string[] = [];
  if (d.modelName) parts.push(d.modelName);
  if (d.tags) parts.push(...d.tags);
  if (d.turnCount != null && d.turnCount > 0) {
    parts.push(formatTurns(d.turnCount, d.maxTurns));
  }
  if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
  if (d.tokens) parts.push(d.tokens);
  if (!parts.length) return "";
  return parts.map((p) => fgPreservingNestedStyles(theme, "dim", p)).join(" " + theme.fg("dim", "·") + " ");
}

export function isErrorStatus(status: string | undefined): boolean {
  return status === "error" || status === "aborted" || status === "stopped";
}

export function isActiveStatus(status: string | undefined): boolean {
  return status === "running" || status === "queued";
}

/** Lightweight heuristic when structured details are missing. */
export function looksLikeFailureText(text: string): boolean {
  const head = text.trim().slice(0, 240);
  return (
    /^error\b/i.test(head) ||
    /\bfailed\b/i.test(head) ||
    /\bnot found\b/i.test(head) ||
    /\bcannot\b/i.test(head) ||
    /\bnot in scope\b/i.test(head) ||
    /\bunavailable\b/i.test(head) ||
    /\binvalid\b/i.test(head) ||
    /\bdisabled\b/i.test(head)
  );
}

/** Compact call title: `▸ Label  muted…`. */
export function renderToolCallTitle(label: string, muted: string | undefined, theme: Theme, dimExtra?: string): Text {
  let line = "▸ " + theme.fg("toolTitle", theme.bold(label));
  if (muted) line += "  " + theme.fg("muted", muted);
  if (dimExtra) line += "  " + theme.fg("dim", dimExtra);
  return new Text(line, 0, 0);
}

function withHeaderAndMarkdown(header: string, markdownBody: string): Component {
  const container = new Container();
  container.addChild(new Text(header, 0, 0));
  const body = markdownBody.trim() || "_(no output)_";
  container.addChild(renderExpandedMarkdown(body));
  return container;
}

/**
 * Fallback when execute returned plain text without AgentDetails.
 * Never assumes success — missing details + failure-ish text → ✗; else neutral •.
 */
export function renderUndetailedResult(
  resultText: string,
  opts: { expanded: boolean; isError?: boolean },
  theme: Theme,
): Component {
  const failed = opts.isError === true || looksLikeFailureText(resultText);
  const icon = failed ? theme.fg("error", "✗") : theme.fg("dim", "•");
  if (opts.expanded) {
    return withHeaderAndMarkdown(icon, resultText.trim() || "_(empty)_");
  }
  const preview = firstLinePreview(resultBodyText(resultText)) || (failed ? "failed" : "ok");
  return new Text(
    icon + " " + theme.fg(failed ? "error" : "dim", `${preview} (${expandHint()})`),
    0,
    0,
  );
}

/**
 * Shared Agent / get_subagent_result result chrome.
 * `resultText` is the full tool content (model-facing); only a preview is shown collapsed.
 * Expanded renders the body as Markdown under a one-line status header.
 */
export function renderAgentLikeResult(
  details: AgentDetails,
  resultText: string,
  opts: { expanded: boolean; isPartial?: boolean },
  theme: Theme,
): Component {
  const s = formatAgentDetailsStats(details, theme);
  const duration =
    details.durationMs > 0 && !isActiveStatus(details.status)
      ? formatMs(details.durationMs)
      : undefined;

  if (opts.isPartial || isActiveStatus(details.status)) {
    const frame = SPINNER[details.spinnerFrame ?? 0] ?? SPINNER[0];
    let line = theme.fg("accent", frame!) + (s ? " " + s : "");
    if (details.agentId) line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", details.agentId);
    const activity =
      details.activity ??
      (details.status === "queued" ? "queued…" : "running…");
    line += "\n" + theme.fg("dim", `  ⎿  ${activity}`);
    return new Text(line, 0, 0);
  }

  if (details.status === "background") {
    return new Text(
      theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId ?? "?"})`),
      0,
      0,
    );
  }

  if (details.status === "completed" || details.status === "steered") {
    const isSteered = details.status === "steered";
    const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
    let header = icon + (s ? " " + s : "");
    if (duration) header += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

    if (opts.expanded) {
      const body = resultBodyText(resultText) || resultText.trim();
      return withHeaderAndMarkdown(header, body);
    }

    const empty = isSteered ? "Wrapped up (turn limit)" : "Done";
    return new Text(appendCollapsedPreviewLine(header, resultText, theme, empty), 0, 0);
  }

  if (details.status === "stopped") {
    let header = theme.fg("dim", "■") + (s ? " " + s : "");
    if (duration) header += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);
    if (opts.expanded && resultText.trim()) {
      return withHeaderAndMarkdown(header + "\n" + theme.fg("dim", "  ⎿  Stopped"), resultBodyText(resultText) || resultText);
    }
    return new Text(header + "\n" + theme.fg("dim", "  ⎿  Stopped"), 0, 0);
  }

  // error / aborted
  let header = theme.fg("error", "✗") + (s ? " " + s : "");
  if (duration) header += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);
  if (details.status === "error") {
    const err =
      details.error?.trim() ||
      firstLinePreview(resultBodyText(resultText)) ||
      firstLinePreview(resultText) ||
      "unknown";
    header += "\n" + theme.fg("error", `  ⎿  Error: ${firstLinePreview(err, 120)}`);
  } else {
    header += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
  }
  if (opts.expanded && resultText.trim()) {
    return withHeaderAndMarkdown(header, resultBodyText(resultText) || resultText);
  }
  return new Text(header, 0, 0);
}
