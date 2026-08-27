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
import { fgPreservingNestedStyles, formatMs, formatTurns, formatUsageCost, SPINNER, styleDuration } from "./agent-widget.js";
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

/** Outcome chips: turns, tool uses, lifetime tokens. Config stays off this list. */
export function formatOutcomeParts(d: AgentDetails): string[] {
  const parts: string[] = [];
  if (d.turnCount != null && d.turnCount > 0) {
    parts.push(formatTurns(d.turnCount, d.maxTurns));
  }
  if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
  if (d.tokens) parts.push(d.tokens);
  if (d.compactionCount && d.compactionCount > 0) parts.push(`⇊${d.compactionCount}`);
  if (d.contextPercent != null && d.contextPercent >= 70) {
    parts.push(`current ctx ${Math.round(d.contextPercent)}%`);
  }
  return parts;
}

function formatModelChip(d: AgentDetails): string | undefined {
  if (!d.modelName) return undefined;
  return d.modelInherited ? `${d.modelName} (inherit)` : d.modelName;
}

/**
 * Spawn-config chips for the expanded footer.
 * Skips effort:/max turns: (own fields), background (visible from the spawn),
 * and the model chip (already on the collapsed clerk).
 */
export function formatConfigParts(d: AgentDetails): string[] {
  const parts: string[] = [];
  if (d.effort) parts.push(`effort: ${d.effort}`);
  if (d.tags) {
    for (const tag of d.tags) {
      if (tag.startsWith("effort:")) continue;
      if (tag.startsWith("max turns:")) continue;
      if (tag === "background") continue;
      parts.push(tag);
    }
  }
  const seen = new Set<string>();
  return parts.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

function joinDimStats(theme: Theme, parts: string[]): string {
  return parts
    .map((p) => fgPreservingNestedStyles(theme, "dim", p))
    .join(" " + theme.fg("dim", "·") + " ");
}

/**
 * Collapsed stats fragment: outcome + resolved model.
 * Kept for tests / inherit-contract assertions.
 */
export function formatAgentDetailsStats(d: AgentDetails, theme: Theme): string {
  const parts = formatOutcomeParts(d);
  const model = formatModelChip(d);
  if (model) parts.push(model);
  if (!parts.length) return "";
  return joinDimStats(theme, parts);
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

export type CallRenderContext = {
  isError?: boolean;
  isPartial?: boolean;
};

export function formatCallMarker(theme: Theme, context?: CallRenderContext): string {
  if (context?.isError) return theme.fg("error", "●");
  if (context?.isPartial) return theme.fg("warning", "●");
  return theme.fg("success", "●");
}

/**
 * Claude Code / tool-display call title:
 *   ● Explore(Find auth files)  haiku · bg
 * Marker color follows the tool-row state; chips stay opt-in.
 */
export function renderToolCallTitle(
  label: string,
  target: string | undefined,
  theme: Theme,
  dimExtra?: string,
  context?: CallRenderContext,
): Text {
  const marker = formatCallMarker(theme, context);
  const name = theme.fg("toolTitle", theme.bold(sanitizeDisplayText(label)));
  const safeTarget = target ? sanitizeDisplayText(target).trim() : "";
  let line = safeTarget ? `${marker} ${name}(${safeTarget})` : `${marker} ${name}`;
  const safeExtra = dimExtra ? sanitizeDisplayText(dimExtra).trim() : "";
  if (safeExtra) line += "  " + theme.fg("dim", safeExtra);
  return new Text(line, 0, 0);
}

function withClerksAndMarkdown(clerkLines: string[], markdownBody: string): Component {
  const container = new Container();
  for (const raw of clerkLines) {
    container.addChild(new Text(raw, 0, 0));
  }
  const body = markdownBody.trim() || "_(no output)_";
  container.addChild(renderExpandedMarkdown(body));
  return container;
}

function outcomeStatusLabel(d: AgentDetails, resultText: string): { text: string; color: string } {
  if (d.status === "steered") return { text: "Wrapped up (turn limit)", color: "warning" };
  if (d.status === "stopped") return { text: "Stopped", color: "dim" };
  if (d.status === "aborted") return { text: "Aborted (max turns exceeded)", color: "warning" };
  if (d.status === "error") {
    const err =
      d.error?.trim() ||
      firstLinePreview(resultBodyText(resultText)) ||
      firstLinePreview(resultText) ||
      "unknown";
    return { text: `Error: ${firstLinePreview(err, 120)}`, color: "error" };
  }
  if (d.status === "background") {
    return { text: `Running in background (ID: ${d.agentId ?? "?"})`, color: "dim" };
  }
  if (d.status === "queued") return { text: "queued…", color: "dim" };
  return { text: "Done", color: "dim" };
}

function appendStatsAndDuration(theme: Theme, line: string, d: AgentDetails, includeModel: boolean): string {
  const parts = formatOutcomeParts(d);
  if (includeModel) {
    const model = formatModelChip(d);
    if (model) parts.push(model);
  }
  if (parts.length) {
    line += " " + theme.fg("dim", "·") + " " + joinDimStats(theme, parts);
  }
  if (d.durationMs > 0 && !isActiveStatus(d.status)) {
    line += " " + theme.fg("dim", "·") + " " + styleDuration(theme, formatMs(d.durationMs));
  }
  return line;
}

/** One Claude Code clerk: `⎿ Done · 3 tool uses · lifetime 1.2k token · 4s · haiku`. */
export function formatOutcomeClerk(d: AgentDetails, resultText: string, theme: Theme): string {
  const status = outcomeStatusLabel(d, resultText);
  return appendStatsAndDuration(
    theme,
    formatClerkLine(theme, status.text, status.color),
    d,
    true,
  );
}

/** Running clerk: `⎿ ⠹ exploring… · 2 tool uses`. Spinner stays here so the call-line ● can stay static. */
export function formatRunningClerk(d: AgentDetails, theme: Theme): string {
  const frame = SPINNER[d.spinnerFrame ?? 0] ?? SPINNER[0];
  const activity = d.status === "queued" ? "queued…" : (d.activity ?? "working…");
  const prefix = theme.fg("dim", "  ⎿  ") + theme.fg("accent", frame!) + " ";
  const parts = formatOutcomeParts(d);
  const model = formatModelChip(d);
  if (model) parts.push(model);
  const rest = [activity, ...parts].join(" · ");
  return prefix + theme.fg("dim", rest);
}

/** Expanded-only clerks: effort/isolation, low context %, cost, transcript, worktree. */
export function formatExpandedObservabilityClerks(d: AgentDetails, theme: Theme): string[] {
  const lines: string[] = [];
  const config = formatConfigParts(d);
  if (config.length) lines.push(formatClerkLine(theme, config.join(" · ")));

  const window: string[] = [];
  if (d.contextPercent != null && d.contextPercent < 70) {
    window.push(`current ctx ${Math.round(d.contextPercent)}%`);
  }
  if (d.cost != null && Number.isFinite(d.cost) && d.cost > 0) {
    window.push(formatUsageCost(d.cost));
  }
  if (window.length) lines.push(formatClerkLine(theme, window.join(" · ")));

  if (d.outputFile) {
    lines.push(formatClerkLine(theme, `transcript: ${sanitizeDisplayText(d.outputFile)}`, "muted"));
  }
  if (d.worktreeSummary) {
    lines.push(formatClerkLine(theme, sanitizeDisplayText(d.worktreeSummary), "muted"));
  }
  return lines;
}

function renderClerkBlock(clerks: string[], markdownBody: string | undefined, expanded: boolean): Component {
  if (expanded && markdownBody !== undefined) {
    return withClerksAndMarkdown(clerks, markdownBody);
  }
  return new Text(clerks.join("\n"), 0, 0);
}

/**
 * Fallback when execute returned plain text without AgentDetails.
 * Marker lives on the call line; result is clerk-only (never green ✓ on failures).
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
  const preview = firstLinePreview(resultBodyText(resultText)) || (failed ? "failed" : "ok");
  const clerk = formatClerkLine(theme, failed ? `Error: ${preview}` : preview, failed ? "error" : "dim");
  if (opts.expanded) {
    return withClerksAndMarkdown([clerk], resultText.trim() || "_(empty)_");
  }
  return new Text(clerk, 0, 0);
}

/**
 * Shared Agent / get_subagent_result result chrome — Claude Code Task shape:
 *
 *   ● Explore(Find auth files)
 *     ⎿  ⠹ exploring… · 2 tool uses
 *     ⎿  Done · 5 tool uses · lifetime 33.8k token · 10 min 13s · haiku
 *
 * The ● lives on renderCall. Collapsed never dumps the model-facing body;
 * expanded adds observability clerks + Markdown under the outcome clerk.
 */
export function renderAgentLikeResult(
  details: AgentDetails,
  resultText: string,
  opts: { expanded: boolean; isPartial?: boolean },
  theme: Theme,
): Component {
  if (opts.isPartial || isActiveStatus(details.status)) {
    return new Text(formatRunningClerk(details, theme), 0, 0);
  }

  const clerks = [formatOutcomeClerk(details, resultText, theme)];
  if (opts.expanded) {
    clerks.push(...formatExpandedObservabilityClerks(details, theme));
  }

  if (details.status === "background") {
    return new Text(clerks[0]!, 0, 0);
  }

  const showBody =
    opts.expanded &&
    (details.status === "completed" ||
      details.status === "steered" ||
      (resultText.trim().length > 0 && details.status !== "queued"));
  return renderClerkBlock(
    clerks,
    showBody ? resultBodyText(resultText) || resultText : undefined,
    showBody,
  );
}
