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

/** Claude Code-style secondary line: `  ⎿  …`. */
export function formatClerkLine(theme: Pick<Theme, "fg">, text: string, color = "dim"): string {
  return theme.fg(color, `  ⎿  ${text}`);
}

/**
 * Optional call-line chips (Claude Code keeps the title clean).
 * Only emits chips for **explicit** args — never invents "model: inherit".
 */
export function formatAgentCallMeta(opts: {
  model?: string;
  modelInherited?: boolean;
  effort?: string;
  background?: boolean;
  extra?: string[];
}): string {
  const parts: string[] = [];
  const model = opts.model?.trim();
  if (model) {
    parts.push(opts.modelInherited ? `${model} (inherit)` : model);
  }
  const effort = opts.effort?.trim();
  if (effort) parts.push(`effort: ${effort}`);
  if (opts.background) parts.push("bg");
  if (opts.extra?.length) {
    for (const x of opts.extra) {
      const t = x.trim();
      if (t) parts.push(t);
    }
  }
  return parts.join(" · ");
}

/** Build "haiku · effort: high · ↻5≤30 · 3 tool uses · 33.8k token" stats fragment. */
export function formatAgentDetailsStats(d: AgentDetails, theme: Theme): string {
  const parts: string[] = [];
  if (d.modelName) {
    parts.push(d.modelInherited ? `${d.modelName} (inherit)` : d.modelName);
  }
  if (d.effort) parts.push(`effort: ${d.effort}`);
  // Tags from buildInvocationTags — skip effort: (already explicit above).
  if (d.tags) {
    for (const tag of d.tags) {
      if (tag.startsWith("effort:")) continue;
      parts.push(tag);
    }
  }
  const seen = new Set<string>();
  const unique = parts.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
  if (d.turnCount != null && d.turnCount > 0) {
    unique.push(formatTurns(d.turnCount, d.maxTurns));
  }
  if (d.toolUses > 0) unique.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
  if (d.tokens) unique.push(d.tokens);
  if (!unique.length) return "";
  return unique.map((p) => fgPreservingNestedStyles(theme, "dim", p)).join(" " + theme.fg("dim", "·") + " ");
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

/**
 * Claude Code-style call title:
 *   ▸ Explore  Find auth files
 * Optional trailing dim chips only when explicitly set (model / effort / bg).
 */
export function renderToolCallTitle(label: string, muted: string | undefined, theme: Theme, dimExtra?: string): Text {
  let line = "▸ " + theme.fg("toolTitle", theme.bold(label));
  if (muted) line += "  " + theme.fg("muted", muted);
  if (dimExtra?.trim()) line += "  " + theme.fg("dim", dimExtra.trim());
  return new Text(line, 0, 0);
}

function withHeaderAndMarkdown(headerLines: string, markdownBody: string): Component {
  const container = new Container();
  for (const raw of headerLines.split("\n")) {
    container.addChild(new Text(raw, 0, 0));
  }
  const body = markdownBody.trim() || "_(no output)_";
  container.addChild(renderExpandedMarkdown(body));
  return container;
}

function statusHeaderLine(
  icon: string,
  stats: string,
  duration: string | undefined,
  theme: Theme,
): string {
  let line = icon + (stats ? " " + stats : "");
  if (duration) line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);
  return line;
}

/**
 * Fallback when execute returned plain text without AgentDetails.
 * Claude Code shape: icon line + ⎿ message (never green ✓ on failures).
 */
export function renderUndetailedResult(
  resultText: string,
  opts: { expanded: boolean; isError?: boolean },
  theme: Theme,
): Component {
  const failed = opts.isError === true || looksLikeFailureText(resultText);
  const icon = failed ? theme.fg("error", "✗") : theme.fg("dim", "•");
  const preview = firstLinePreview(resultBodyText(resultText)) || (failed ? "failed" : "ok");
  const clerk = formatClerkLine(theme, failed ? `Error: ${preview}` : preview, failed ? "error" : "dim");
  if (opts.expanded) {
    return withHeaderAndMarkdown(icon + "\n" + clerk, resultText.trim() || "_(empty)_");
  }
  return new Text(icon + "\n" + clerk, 0, 0);
}

/**
 * Shared Agent / get_subagent_result result chrome — Claude Code transcript shape:
 *
 *   ⠹ ↻3 · 3 tool uses · 12.4k token
 *     ⎿  searching…
 *   ✓ ↻8 · 5 tool uses · 33.8k token · 12.3s
 *     ⎿  Done
 *
 * Collapsed never dumps the model-facing body; expanded adds Markdown under the chrome.
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

  // Running / queued — match upstream renderRunningAgentStatus layout
  if (opts.isPartial || isActiveStatus(details.status)) {
    const frame = SPINNER[details.spinnerFrame ?? 0] ?? SPINNER[0];
    const top = theme.fg("accent", frame!) + (s ? " " + s : "");
    const activity =
      details.activity ??
      (details.status === "queued" ? "queued…" : "thinking…");
    return new Text(top + "\n" + formatClerkLine(theme, activity), 0, 0);
  }

  // Background launch — single clerk line (upstream CC style)
  if (details.status === "background") {
    return new Text(
      formatClerkLine(theme, `Running in background (ID: ${details.agentId ?? "?"})`),
      0,
      0,
    );
  }

  if (details.status === "completed" || details.status === "steered") {
    const isSteered = details.status === "steered";
    const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
    const header = statusHeaderLine(icon, s, duration, theme);
    const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
    const clerk = formatClerkLine(theme, doneText);

    if (opts.expanded) {
      const body = resultBodyText(resultText) || resultText.trim();
      return withHeaderAndMarkdown(header + "\n" + clerk, body);
    }
    return new Text(header + "\n" + clerk, 0, 0);
  }

  if (details.status === "stopped") {
    const header = statusHeaderLine(theme.fg("dim", "■"), s, duration, theme);
    const clerk = formatClerkLine(theme, "Stopped");
    if (opts.expanded && resultText.trim()) {
      return withHeaderAndMarkdown(header + "\n" + clerk, resultBodyText(resultText) || resultText);
    }
    return new Text(header + "\n" + clerk, 0, 0);
  }

  // error / aborted
  const header = statusHeaderLine(theme.fg("error", "✗"), s, duration, theme);
  let clerk: string;
  if (details.status === "error") {
    const err =
      details.error?.trim() ||
      firstLinePreview(resultBodyText(resultText)) ||
      firstLinePreview(resultText) ||
      "unknown";
    clerk = formatClerkLine(theme, `Error: ${firstLinePreview(err, 120)}`, "error");
  } else {
    clerk = formatClerkLine(theme, "Aborted (max turns exceeded)", "warning");
  }
  if (opts.expanded && resultText.trim()) {
    return withHeaderAndMarkdown(header + "\n" + clerk, resultBodyText(resultText) || resultText);
  }
  return new Text(header + "\n" + clerk, 0, 0);
}
