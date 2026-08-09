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
import { fgPreservingNestedStyles, formatMs, formatTurns, SPINNER, styleDuration } from "./agent-widget.js";
import { sanitizeDisplayText } from "./display-safety.js";

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
    .map((c) => sanitizeDisplayText(c.text ?? ""))
    .join("\n");
}

/** First non-empty line, collapsed to a single visual line. */
export function firstLinePreview(text: string, maxChars = RESULT_COLLAPSED_PREVIEW_CHARS): string {
  const line =
    sanitizeDisplayText(text)
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
 *
 * Deliberately strict:
 * - Does NOT peel "Note: Unknown agent type…" (user must see the fallback warning).
 * - `Agent:` + `Type:` only match the real get_subagent_result meta shape
 *   (`Type: … | Status: …`), so agent-authored reports are not eaten.
 */
export function looksLikeStatusHeader(block: string): boolean {
  const head = sanitizeDisplayText(block).trim();
  if (!head) return false;
  if (/^Agent completed in \d/i.test(head)) return true;
  if (/^Agent failed:/i.test(head)) return true;
  // get_subagent_result multi-line meta block (requires Status on the Type line)
  if (/^Agent:\s+\S+/m.test(head) && /^Type:\s+.+\|\s*Status:\s*/m.test(head)) return true;
  if (/^Agent (queued|started) in background/i.test(head)) return true;
  return false;
}

/**
 * Prefer the body after a recognized status header; otherwise keep full text.
 * Prevents multi-paragraph errors like "Model not in scope…\n\nAllowed…" from
 * losing their first (most important) paragraph in previews.
 */
export function resultBodyText(text: string): string {
  const normalized = sanitizeDisplayText(text).trim();
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
  return new Markdown(sanitizeDisplayText(content), 0, 0, getMarkdownTheme());
}

/** Claude Code-style secondary line: `  ⎿  …`. */
export function formatClerkLine(theme: Pick<Theme, "fg">, text: string, color = "dim"): string {
  return theme.fg(color, `  ⎿  ${sanitizeDisplayText(text)}`);
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
  const model = opts.model ? sanitizeDisplayText(opts.model).trim() : "";
  if (model) {
    parts.push(opts.modelInherited ? `${model} (inherit)` : model);
  }
  const effort = opts.effort ? sanitizeDisplayText(opts.effort).trim() : "";
  if (effort) parts.push(`effort: ${effort}`);
  if (opts.background) parts.push("bg");
  if (opts.extra?.length) {
    for (const x of opts.extra) {
      const t = sanitizeDisplayText(x).trim();
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
  // Tags from buildInvocationTags — skip effort: / max turns: (already explicit via
  // effort field and formatTurns below).
  if (d.tags) {
    for (const tag of d.tags) {
      if (tag.startsWith("effort:")) continue;
      if (tag.startsWith("max turns:")) continue;
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

/**
 * Lightweight heuristic when structured details / explicit isError are missing.
 * Only matches strong *leading* failure markers — never free-word scans of user
 * content (schedule names like "Investigate failed tests" must not go red).
 */
export function looksLikeFailureText(text: string): boolean {
  const head = sanitizeDisplayText(text).trim().slice(0, 240);
  return (
    /^error\b/i.test(head) ||
    /^failed\b/i.test(head) ||
    /^agent failed:/i.test(head) ||
    /^model not in scope\b/i.test(head) ||
    /^agent not found\b/i.test(head) ||
    /^cannot combine\b/i.test(head) ||
    /^scheduling is disabled\b/i.test(head) ||
    /^failed to (resume|steer)\b/i.test(head)
  );
}

/** Statuses that should flip Pi's tool-result `isError` (error shell / model flag). */
export function isFailureDetailsStatus(status: string | undefined): boolean {
  return status === "error" || status === "aborted" || status === "stopped";
}

/**
 * Claude Code-style call title:
 *   ▸ Explore  Find auth files
 * Optional trailing dim chips only when explicitly set (model / effort / bg).
 */
export function renderToolCallTitle(label: string, muted: string | undefined, theme: Theme, dimExtra?: string): Text {
  let line = "▸ " + theme.fg("toolTitle", theme.bold(sanitizeDisplayText(label)));
  const safeMuted = muted ? sanitizeDisplayText(muted) : "";
  const safeExtra = dimExtra ? sanitizeDisplayText(dimExtra).trim() : "";
  if (safeMuted) line += "  " + theme.fg("muted", safeMuted);
  if (safeExtra) line += "  " + theme.fg("dim", safeExtra);
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
  if (duration) line += " " + theme.fg("dim", "·") + " " + styleDuration(theme, duration);
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
  // Explicit false wins (success paths); explicit true forces error; undefined
  // falls back to a tight leading-marker heuristic only.
  const failed =
    opts.isError === true
      ? true
      : opts.isError === false
        ? false
        : looksLikeFailureText(resultText);
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
 *   ⠹ ↻3 · 3 tool uses · lifetime 12.4k token
 *     ⎿  searching…
 *   ✓ ↻8 · 5 tool uses · lifetime 33.8k token · 10 min 13s
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
    // Queued must never show a generic working fallback, even if stale activity was attached.
    const activity =
      details.status === "queued"
        ? "queued…"
        : (details.activity ?? "working…");
    return new Text(top + "\n" + formatClerkLine(theme, activity), 0, 0);
  }

  // Background launch — single clerk line (upstream CC style). Queued is handled above.
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
