/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 *
 * Displays a tree of agents with animated spinners, live stats, and activity descriptions.
 * Uses the callback form of setWidget for themed rendering.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.js";
import { getConfig } from "../agent-types.js";
import type { AgentInvocation, AgentRecord, SubagentType, WidgetMode } from "../types.js";
import { getLifetimeTotal, getSessionContextPercent, type LifetimeUsage, type SessionLike } from "../usage.js";
import { sanitizeDisplayText } from "./display-safety.js";

// ---- Constants ----

/** Maximum number of rendered lines before overflow collapse kicks in. */
const MAX_WIDGET_LINES = 12;

/** Braille spinner frames for animated running indicator. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Statuses that indicate an error/non-success outcome (used for linger behavior and icon rendering). */
export const ERROR_STATUSES = new Set(["error", "aborted", "steered", "stopped"]);

/** Stable, coarse phases allowed on compact running surfaces. */
export type ActivityPhase = "exploring" | "editing" | "runningCommands" | "delegating";

/** A phase must remain active this long before compact UI promotes it above `working…`. */
export const ACTIVITY_PHASE_PROMOTION_MS = 800;
/** Once promoted, keep a phase visible long enough to avoid flashing between labels. */
export const ACTIVITY_PHASE_MIN_HOLD_MS = 1500;
/** Same-phase tools separated by only this gap count as one continuous phase. */
export const ACTIVITY_PHASE_GAP_MS = 200;

/** Tool name → human-readable action for detailed activity descriptions. */
const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding",
  ls: "listing",
  Agent: "spawning",
  get_subagent_result: "awaiting",
  steer_subagent: "steering",
};

/** Conservative classification: unknown/custom tools stay on the honest generic fallback. */
const TOOL_ACTIVITY_PHASE: Readonly<Record<string, ActivityPhase>> = {
  read: "exploring",
  grep: "exploring",
  find: "exploring",
  ls: "exploring",
  web_search: "exploring",
  web_read: "exploring",
  ollama_web_search: "exploring",
  ollama_web_fetch: "exploring",
  "resolve-library-id": "exploring",
  "query-docs": "exploring",
  edit: "editing",
  write: "editing",
  bash: "runningCommands",
  agent: "delegating",
  get_subagent_result: "delegating",
  steer_subagent: "delegating",
};

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

/** Mutable debounce state for the compact phase summary. */
export interface ActivityPhaseSummaryState {
  candidate?: ActivityPhase;
  candidateSince?: number;
  inactiveSince?: number;
  visible?: ActivityPhase;
  visibleSince?: number;
}

/** Coarse phase metadata for one in-flight tool. */
export interface ActiveToolPhase {
  phase?: ActivityPhase;
  startedAt: number;
}

/** Per-agent live activity state. */
export interface AgentActivity {
  /**
   * In-flight tools: key = toolCallId (or synthetic), value = one-line step summary
   * e.g. "reading src/a.ts", "running rg auth". Kept for the detailed overlay.
   */
  activeTools: Map<string, string>;
  /** Matching coarse phase and start time for each in-flight tool. */
  activeToolPhases: Map<string, ActiveToolPhase>;
  /** Debounce/minimum-hold state used only by compact running surfaces. */
  phaseSummary: ActivityPhaseSummaryState;
  toolUses: number;
  /** Streaming assistant body retained for the detailed conversation overlay only. */
  responseText: string;
  session?: SessionLike;
  /** Current turn count. */
  turnCount: number;
  /** Effective max turns for this agent (undefined = unlimited). */
  maxTurns?: number;
  /** Ephemeral live usage mirror for foreground streaming; AgentRecord is authoritative when available. */
  lifetimeUsage: LifetimeUsage;
}

/** Metadata attached to Agent tool results for custom rendering. */
export interface AgentDetails {
  displayName: string;
  description: string;
  subagentType: string;
  toolUses: number;
  tokens: string;
  durationMs: number;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error" | "background";
  /** Compact activity label: a stable coarse phase, `working…`, or queued status. */
  activity?: string;
  /** Current spinner frame index (for animated running indicator). */
  spinnerFrame?: number;
  /** Effective short model label when known (e.g. "haiku", "sonnet") — including parent-inherited. */
  modelName?: string;
  /** True when the effective model is the parent session model. */
  modelInherited?: boolean;
  /**
   * Thinking / effort level for TUI (maps from tool/frontmatter `thinking`).
   * Shown as `effort: <level>` for Claude Code-adjacent wording.
   */
  effort?: string;
  /** Notable config tags (e.g. ["effort: high", "isolated", "background"]). */
  tags?: string[];
  /** Current turn count. */
  turnCount?: number;
  /** Effective max turns (undefined = unlimited). */
  maxTurns?: number;
  agentId?: string;
  error?: string;
  /** Current context-window fill (0–100). Null/undefined = unknown. */
  contextPercent?: number | null;
  /** How many times this run compacted. */
  compactionCount?: number;
  /** Accumulated provider-reported USD cost when known. */
  cost?: number;
  /** Streaming .output transcript path. */
  outputFile?: string;
  /** Compact worktree identity, e.g. `worktree feat-foo · dirty`. */
  worktreeSummary?: string;
}

// ---- Formatting helpers ----

/** Apply foreground styling while restoring it after nested foreground/full ANSI resets. */
export function fgPreservingNestedStyles(theme: Theme, color: string, text: string): string {
  const styledEmpty = theme.fg(color, "");
  const styleStart = styledEmpty.replace(/\u001b\[(?:0|39)m/g, "");
  return theme.fg(color, text.replace(/\u001b\[(?:0|39)m/g, reset => `${reset}${styleStart}`));
}

/** Format a token count magnitude without a unit: "33.8k", "1.2M". */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${count}`;
}

/** Format a token count compactly: "33.8k token", "1.2M token". */
export function formatTokens(count: number): string {
  return `${formatTokenCount(count)} token`;
}

/** Format provider-reported USD cost with the same precision policy as pi-glance. */
export function formatUsageCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.000";
  if (cost < 0.001) return "<$0.001";
  if (cost < 1) return `$${cost.toFixed(3)}`;
  if (cost < 10) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(1)}`;
}

/** Clear, fully additive lifetime breakdown for the conversation detail overlay. */
export function formatLifetimeUsageBreakdown(usage: LifetimeUsage): string {
  const parts = [
    `input ${formatTokenCount(usage.input ?? 0)}`,
    `output ${formatTokenCount(usage.output ?? 0)}`,
    `cache read ${formatTokenCount(usage.cacheRead ?? 0)}`,
    `cache write ${formatTokenCount(usage.cacheWrite ?? 0)}`,
  ];
  if (usage.cost !== undefined && Number.isFinite(usage.cost)) {
    parts.push(`cost ${formatUsageCost(usage.cost)}`);
  }
  return `Lifetime usage: ${parts.join(" · ")}`;
}

/**
 * Compact lifetime total with optional *current* context-fill % and compaction
 * annotations. The labels deliberately make the two windows explicit: lifetime
 * usage is cumulative, while context % describes only the current context.
 * Thresholds for percent: <70% dim, 70–85% warning, ≥85% error.
 */
export function formatSessionTokens(
  tokens: number,
  percent: number | null,
  theme: Theme,
  compactions = 0,
): string {
  const tokenStr = `lifetime ${formatTokens(tokens)}`;
  const annot: string[] = [];
  if (percent !== null) {
    const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
    annot.push(theme.fg(color, `current ctx ${Math.round(percent)}%`));
  }
  if (compactions > 0) {
    annot.push(theme.fg("dim", `⇊${compactions}`));
  }
  if (annot.length === 0) return tokenStr;
  return `${tokenStr} (${annot.join(" · ")})`;
}

/** Format turn count with optional max limit: "↻5≤30" or "↻5". */
export function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `↻${turnCount}≤${maxTurns}` : `↻${turnCount}`;
}

/**
 * Format milliseconds as a stable human duration.
 * Sub-minute values retain tenths; longer values use minute/hour units instead
 * of growing into unreadable long-second counts.
 */
export function formatMs(ms: number): string {
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (safeMs < 60_000) {
    const seconds = Math.floor(safeMs / 100) / 10;
    return `${Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
  }

  const totalSeconds = Math.floor(safeMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min ${seconds}s`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} hr ${minutes} min ${seconds}s`;
}

/** Apply the shared semantic duration color without brightening surrounding stats. */
export function styleDuration(theme: Pick<Theme, "fg">, duration: string): string {
  return theme.fg("accent", duration);
}

/** Format duration from start/completed timestamps. */
export function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt !== undefined) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

function styleStatsWithDuration(parts: string[], duration: string, theme: Theme): string {
  return [
    ...parts.map((part) => fgPreservingNestedStyles(theme, "dim", part)),
    styleDuration(theme, duration),
  ].join(" " + theme.fg("dim", "·") + " ");
}

/** Get display name for any agent type (built-in or custom). */
export function getDisplayName(type: SubagentType, inlineDisplayName?: string): string {
  return inlineDisplayName ?? getConfig(type).displayName;
}

/** Short label for prompt mode: "twin" for append, nothing for replace (the default). */
export function getPromptModeLabel(
  type: SubagentType,
  inlinePromptMode?: "replace" | "append",
): string | undefined {
  const promptMode = inlinePromptMode ?? getConfig(type).promptMode;
  return promptMode === "append" ? "twin" : undefined;
}

/** Short model label for TUI (strips leading "Claude ", lowercases). */
export function shortModelLabel(model: { id?: string; name?: string } | null | undefined): string | undefined {
  if (!model) return undefined;
  const raw = (model.name ?? model.id ?? "").trim();
  if (!raw) return undefined;
  return raw.replace(/^Claude\s+/i, "").toLowerCase();
}

/** Mode label is not included — callers add it where they want it. */
export function buildInvocationTags(
  invocation: AgentInvocation | undefined,
): { modelName?: string; tags: string[] } {
  const tags: string[] = [];
  if (!invocation) return { tags };
  // TUI wording: effort (Claude Code-adjacent); source field remains `thinking`.
  if (invocation.thinking) tags.push(`effort: ${invocation.thinking}`);
  if (invocation.isolated) tags.push("isolated");
  if (invocation.isolation === "worktree") tags.push("worktree");
  if (invocation.inheritContext) tags.push("inherit context");
  if (invocation.runInBackground) tags.push("background");
  if (invocation.maxTurns != null) tags.push(`max turns: ${invocation.maxTurns}`);
  const modelName = invocation.modelName
    ? (invocation.modelInherited ? `${invocation.modelName} (inherit)` : invocation.modelName)
    : undefined;
  return { modelName, tags };
}

/**
 * Rebuild Agent tool-result details fields from a stored invocation snapshot.
 * Keeps Agent row and get_subagent_result row chips aligned (model/inherit/effort).
 */
export function detailsFromInvocation(invocation: AgentInvocation | undefined): Pick<
  AgentDetails,
  "modelName" | "modelInherited" | "effort" | "tags"
> {
  if (!invocation) return {};
  const { tags } = buildInvocationTags(invocation);
  return {
    modelName: invocation.modelName,
    modelInherited: invocation.modelInherited,
    effort: invocation.thinking ? String(invocation.thinking) : undefined,
    tags: tags.length > 0 ? tags : undefined,
  };
}

/** Truncate text to a single line, max `len` chars. */
function truncateLine(text: string, len = 60): string {
  const line = sanitizeDisplayText(text).split("\n").find(l => l.trim())?.trim() ?? "";
  if (line.length <= len) return line;
  return line.slice(0, len) + "…";
}

/**
 * Compact status-bar copy used only when the above-editor widget is off.
 * Returns undefined when there is nothing to report.
 */
export function formatSubagentsStatusText(runningCount: number, queuedCount: number): string | undefined {
  if (runningCount <= 0 && queuedCount <= 0) return undefined;
  const parts: string[] = [];
  if (runningCount > 0) parts.push(`${runningCount} running`);
  if (queuedCount > 0) parts.push(`${queuedCount} queued`);
  const total = runningCount + queuedCount;
  return `${parts.join(", ")} agent${total === 1 ? "" : "s"}`;
}

/**
 * One-line summary for an in-flight tool in the detailed conversation overlay.
 * Prefers path/command/pattern from args when present.
 */
export function formatActiveToolSummary(toolName: string, args?: unknown): string {
  const safeToolName = sanitizeDisplayText(toolName);
  if (safeToolName.startsWith("tools-error:") || safeToolName.startsWith("extension-error:")) {
    return truncateLine(safeToolName.replace(/^(tools|extension)-error:/, "⚠ "), 70);
  }
  const action = TOOL_DISPLAY[safeToolName] ?? safeToolName;
  const record =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  // Inline lightweight detail extraction (mirrors conversation-brief summarizeToolArgs keys).
  const firstString = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = record[k];
      if (typeof v !== "string") continue;
      const safe = sanitizeDisplayText(v).trim();
      if (safe) return safe;
    }
    return undefined;
  };
  const path = firstString("path", "file_path", "filePath", "filename", "file", "target");
  const command = firstString("command", "cmd");
  const pattern = firstString("pattern", "query", "regex", "search");
  const glob = firstString("glob", "include", "glob_pattern", "globPattern");
  const url = firstString("url");
  let detail: string | undefined;
  if (command) detail = command;
  else if (path) detail = path;
  else if (pattern && (path || glob)) detail = `${JSON.stringify(pattern)} ${path ?? glob}`;
  else if (pattern) detail = JSON.stringify(pattern);
  else if (glob) detail = glob;
  else if (url) detail = url;
  if (detail) {
    const one = detail.replace(/\s+/g, " ");
    const clipped = one.length > 48 ? `${one.slice(0, 47)}…` : one;
    return `${action} ${clipped}`;
  }
  return action;
}

/** Map a known tool onto a deliberately coarse compact-UI phase. */
export function getToolActivityPhase(toolName: string): ActivityPhase | undefined {
  const normalized = sanitizeDisplayText(toolName).trim().toLowerCase();
  return TOOL_ACTIVITY_PHASE[normalized];
}

function observeActivePhase(
  state: ActivityPhaseSummaryState,
  phase: ActivityPhase | undefined,
  now: number,
  phaseSince = now,
): void {
  if (phase === undefined) {
    state.candidate = undefined;
    state.candidateSince = undefined;
    state.inactiveSince = undefined;
    return;
  }

  const continuesCandidate = state.candidate === phase
    && (state.inactiveSince === undefined || now - state.inactiveSince <= ACTIVITY_PHASE_GAP_MS);
  if (!continuesCandidate || state.candidateSince === undefined) {
    state.candidateSince = phaseSince;
  }
  state.candidate = phase;
  state.inactiveSince = undefined;
}

/**
 * Pick one truthful phase without letting a short parallel tool displace stable
 * work. Keep the visible/candidate phase while any matching tool remains;
 * otherwise choose the oldest known in-flight phase. Unknown tools are ignored
 * when a known phase is still active.
 */
function selectActivePhase(activity: AgentActivity): { phase?: ActivityPhase; since?: number } {
  const known = [...activity.activeToolPhases.values()]
    .filter((entry): entry is ActiveToolPhase & { phase: ActivityPhase } => entry.phase !== undefined);
  if (known.length === 0) return {};

  for (const preferred of [activity.phaseSummary.visible, activity.phaseSummary.candidate]) {
    if (preferred === undefined) continue;
    const matching = known.filter((entry) => entry.phase === preferred);
    if (matching.length > 0) {
      return {
        phase: preferred,
        since: Math.min(...matching.map((entry) => entry.startedAt)),
      };
    }
  }

  const oldest = known.reduce((selected, entry) =>
    entry.startedAt < selected.startedAt ? entry : selected);
  return { phase: oldest.phase, since: oldest.startedAt };
}

/** Record a tool start for compact phase debouncing; detailed args never enter this state. */
export function trackActivityPhaseStart(
  activity: AgentActivity,
  toolCallId: string,
  toolName: string,
  now = Date.now(),
): void {
  activity.activeToolPhases.set(toolCallId, {
    phase: getToolActivityPhase(toolName),
    startedAt: now,
  });
  const selected = selectActivePhase(activity);
  observeActivePhase(activity.phaseSummary, selected.phase, now, selected.since);
}

/** Record a tool end while allowing a very short same-phase gap to remain continuous. */
export function trackActivityPhaseEnd(
  activity: AgentActivity,
  toolCallId: string,
  now = Date.now(),
): void {
  activity.activeToolPhases.delete(toolCallId);
  if (activity.activeToolPhases.size === 0) {
    activity.phaseSummary.inactiveSince = now;
    return;
  }
  const selected = selectActivePhase(activity);
  observeActivePhase(activity.phaseSummary, selected.phase, now, selected.since);
}

function phaseLabel(phase: ActivityPhase): string {
  switch (phase) {
    case "exploring": return "exploring…";
    case "editing": return "editing…";
    case "runningCommands": return "running commands…";
    case "delegating": return "delegating…";
  }
}

/**
 * Stable activity for compact surfaces. Fast/unknown tools and streaming body
 * text deliberately stay `working…`; only a durable coarse phase is promoted.
 */
export function describeCompactActivity(activity: AgentActivity, now = Date.now()): string {
  const state = activity.phaseSummary;
  const hasActiveTools = activity.activeToolPhases.size > 0;
  const selected = selectActivePhase(activity);
  const activePhase = selected.phase;

  if (!hasActiveTools || activePhase === undefined) {
    if (hasActiveTools) {
      // An unknown/custom tool is real work, but not a phase we can label honestly.
      state.candidate = undefined;
      state.candidateSince = undefined;
      state.inactiveSince = undefined;
    } else if (state.inactiveSince === undefined) {
      state.inactiveSince = now;
    }

    if (
      state.visible !== undefined
      && state.visibleSince !== undefined
      && now - state.visibleSince < ACTIVITY_PHASE_MIN_HOLD_MS
    ) {
      return phaseLabel(state.visible);
    }

    state.visible = undefined;
    state.visibleSince = undefined;
    if (
      !hasActiveTools
      && state.inactiveSince !== undefined
      && now - state.inactiveSince >= ACTIVITY_PHASE_GAP_MS
    ) {
      state.candidate = undefined;
      state.candidateSince = undefined;
    }
    return "working…";
  }

  if (
    state.candidate !== activePhase
    || state.candidateSince === undefined
    || state.inactiveSince !== undefined
  ) {
    observeActivePhase(state, activePhase, now, selected.since);
  }

  // A same-named phase is immediately reusable only when it is the same
  // continuous candidate that originally promoted the visible label. After a
  // long unrendered idle gap, candidateSince is newer and must earn 800ms again.
  const visibleBelongsToCandidate = state.visible === activePhase
    && state.visibleSince !== undefined
    && state.candidateSince !== undefined
    && state.candidateSince <= state.visibleSince;
  if (visibleBelongsToCandidate) return phaseLabel(activePhase);
  if (
    state.visible !== undefined
    && state.visibleSince !== undefined
    && now - state.visibleSince < ACTIVITY_PHASE_MIN_HOLD_MS
  ) {
    return phaseLabel(state.visible);
  }

  state.visible = undefined;
  state.visibleSince = undefined;
  if (state.candidateSince !== undefined && now - state.candidateSince >= ACTIVITY_PHASE_PROMOTION_MS) {
    state.visible = activePhase;
    state.visibleSince = now;
    return phaseLabel(activePhase);
  }
  return "working…";
}

/**
 * Detailed live activity for the conversation overlay.
 * Prefer exact in-flight tool steps; else streaming assistant text; else `working…`.
 */
export function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
  if (activeTools.size > 0) {
    const parts = [...activeTools.values()]
      .map((part) => sanitizeDisplayText(part))
      .filter((part) => part.trim().length > 0);
    if (parts.length === 1) {
      const p = parts[0]!;
      return p.endsWith("…") ? p : `${p}…`;
    }
    if (parts.length > 1) {
      const head = parts.slice(0, 2).join(", ");
      const more = parts.length > 2 ? ` +${parts.length - 2}` : "";
      return `${head}${more}…`;
    }
  }

  // No tools active — show truncated response text if available
  if (responseText && responseText.trim().length > 0) {
    return truncateLine(responseText);
  }

  return "working…";
}

// ---- Widget manager ----

export class AgentWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** Tracks how many turns each finished agent has survived. Key: agent ID, Value: turns since finished. */
  private finishedTurnAge = new Map<string, number>();
  /** How many extra turns errors/aborted agents linger (completed agents clear after 1 turn). */
  private static readonly ERROR_LINGER_TURNS = 2;

  /** Whether the widget callback is currently registered with the TUI. */
  private widgetRegistered = false;
  /** Cached TUI reference from widget factory callback, used for requestRender(). */
  private tui: any | undefined;
  /** Last status bar text, used to avoid redundant setStatus calls. */
  private lastStatusText: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    /**
     * Read live at render time. Selects which agents the widget shows — see
     * `WidgetMode`. Defaults to `"all"` when a caller supplies no policy; the
     * extension supplies one defaulting to `"background"`.
     */
    private mode: () => WidgetMode = () => "all",
  ) {}

  /**
   * Agents eligible for the widget, per the current `WidgetMode`:
   *   - `off`: none (the widget's existing empty-state path hides it entirely).
   *   - `background`: drop only agents *known* to be foreground
   *     (`isBackground === false`); keep everything else — background, queued,
   *     scheduled, or RPC-spawned (`undefined`). Keying off the `isBackground`
   *     record flag rather than the UI-only `invocation` snapshot (which only the
   *     Agent-tool path sets), and excluding rather than allow-listing, means
   *     only proven-foreground runs drop out — nothing else silently vanishes.
   *   - `all`: every agent.
   */
  private widgetAgents() {
    const all = this.manager.listAgents();
    switch (this.mode()) {
      case "off": return [];
      case "background": return all.filter(a => a.isBackground !== false);
      default: return all;
    }
  }

  /** Set the UI context (grabbed from first tool execution). */
  setUICtx(ctx: UICtx) {
    if (ctx !== this.uiCtx) {
      // UICtx changed — the widget registered on the old context is gone.
      // Force re-registration on next update().
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
      this.lastStatusText = undefined;
    }
  }

  /**
   * Called on each new turn (tool_execution_start).
   * Ages finished agents and clears those that have lingered long enough.
   */
  onTurnStart() {
    // Age all finished agents
    for (const [id, age] of this.finishedTurnAge) {
      this.finishedTurnAge.set(id, age + 1);
    }
    // Trigger a widget refresh (will filter out expired agents)
    this.update();
  }

  /** Ensure the widget update timer is running. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), 80);
    }
  }

  /** Check if a finished agent should still be shown in the widget. */
  private shouldShowFinished(agentId: string, status: string): boolean {
    const age = this.finishedTurnAge.get(agentId) ?? 0;
    const maxAge = ERROR_STATUSES.has(status) ? AgentWidget.ERROR_LINGER_TURNS : 1;
    return age < maxAge;
  }

  /** Record an agent as finished (call when agent completes). */
  markFinished(agentId: string) {
    if (!this.finishedTurnAge.has(agentId)) {
      this.finishedTurnAge.set(agentId, 0);
    }
  }

  /** Hide a caller-owned terminal row immediately; its orchestrator owns summary UI. */
  dismissFinished(agentId: string) {
    this.finishedTurnAge.set(agentId, Number.POSITIVE_INFINITY);
  }

  /** Render a finished agent line. */
  private renderFinishedLine(a: AgentRecord, theme: Theme): string {
    const name = getDisplayName(a.type, a.inlineDisplayName);
    const modeLabel = getPromptModeLabel(a.type, a.inlinePromptMode);
    const duration = formatMs((a.completedAt ?? Date.now()) - a.startedAt);

    let icon: string;
    let statusText: string;
    if (a.status === "completed") {
      icon = theme.fg("success", "✓");
      statusText = "";
    } else if (a.status === "steered") {
      icon = theme.fg("warning", "✓");
      statusText = theme.fg("warning", " (turn limit)");
    } else if (a.status === "stopped") {
      icon = theme.fg("dim", "■");
      statusText = theme.fg("dim", " stopped");
    } else if (a.status === "error") {
      icon = theme.fg("error", "✗");
      const errMsg = a.error ? `: ${a.error.slice(0, 60)}` : "";
      statusText = theme.fg("error", ` error${errMsg}`);
    } else {
      // aborted
      icon = theme.fg("error", "✗");
      statusText = theme.fg("warning", " aborted");
    }

    const parts: string[] = [];
    const activity = this.agentActivity.get(a.id);
    if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns));
    if (a.toolUses > 0) parts.push(`${a.toolUses} tool use${a.toolUses === 1 ? "" : "s"}`);
    const statsText = styleStatsWithDuration(parts, duration, theme);

    const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
    return `${icon} ${theme.fg("dim", name)}${modeTag}  ${theme.fg("dim", a.description)} ${theme.fg("dim", "·")} ${statsText}${statusText}`;
  }

  /**
   * Render the widget content. Called from the registered widget's render() callback,
   * reading live state each time instead of capturing it in a closure.
   */
  private renderWidget(tui: any, theme: Theme): string[] {
    const allAgents = this.widgetAgents();
    const running = allAgents.filter(a => a.status === "running");
    const queued = allAgents.filter(a => a.status === "queued");
    const finished = allAgents.filter(a =>
      a.status !== "running" && a.status !== "queued" && a.completedAt
      && this.shouldShowFinished(a.id, a.status),
    );

    const hasActive = running.length > 0 || queued.length > 0;
    const hasFinished = finished.length > 0;

    // Nothing to show — return empty (widget will be unregistered by update())
    if (!hasActive && !hasFinished) return [];

    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);
    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";
    const frame = SPINNER[this.widgetFrame % SPINNER.length];

    // Build sections separately for overflow-aware assembly.
    // Each running agent = 2 lines (header + activity), finished = 1 line, queued = 1 line.

    const finishedLines: string[] = [];
    for (const a of finished) {
      finishedLines.push(truncate(theme.fg("dim", "├─") + " " + this.renderFinishedLine(a, theme)));
    }

    const runningLines: string[][] = []; // each entry is [header, activity]
    for (const a of running) {
      const name = getDisplayName(a.type, a.inlineDisplayName);
      const modeLabel = getPromptModeLabel(a.type, a.inlinePromptMode);
      const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
      const elapsed = formatMs(Date.now() - a.startedAt);

      const bg = this.agentActivity.get(a.id);
      // AgentRecord is the lifetime source of truth. The live tracker is an
      // ephemeral mirror and can outlive a completed run during group hold,
      // while resume updates only the record.
      const toolUses = a.toolUses;
      const tokens = getLifetimeTotal(a.lifetimeUsage);
      const contextPercent = getSessionContextPercent(bg?.session ?? a.session);
      const tokenText = tokens > 0 ? formatSessionTokens(tokens, contextPercent, theme, a.compactionCount) : "";

      const parts: string[] = [];
      if (bg) parts.push(formatTurns(bg.turnCount, bg.maxTurns));
      if (toolUses > 0) parts.push(`${toolUses} tool use${toolUses === 1 ? "" : "s"}`);
      if (tokenText) parts.push(tokenText);
      const statsText = styleStatsWithDuration(parts, elapsed, theme);

      const activity = bg ? describeCompactActivity(bg) : "working…";

      runningLines.push([
        truncate(theme.fg("dim", "├─") + ` ${theme.fg("accent", frame)} ${theme.bold(name)}${modeTag}  ${theme.fg("muted", a.description)} ${theme.fg("dim", "·")} ${statsText}`),
        truncate(theme.fg("dim", "│  ") + theme.fg("dim", `  ⎿  ${activity}`)),
      ]);
    }

    const queuedLine = queued.length > 0
      ? truncate(theme.fg("dim", "├─") + ` ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`)
      : undefined;

    // Assemble with overflow cap (heading + overflow indicator = 2 reserved lines).
    const maxBody = MAX_WIDGET_LINES - 1; // heading takes 1 line
    const totalBody = finishedLines.length + runningLines.length * 2 + (queuedLine ? 1 : 0);

    const lines: string[] = [truncate(theme.fg(headingColor, headingIcon) + " " + theme.fg(headingColor, "Agents"))];

    if (totalBody <= maxBody) {
      // Everything fits — add all lines and fix up connectors for the last item.
      lines.push(...finishedLines);
      for (const pair of runningLines) lines.push(...pair);
      if (queuedLine) lines.push(queuedLine);

      // Fix last connector: swap ├─ → └─ and │ → space for activity lines.
      if (lines.length > 1) {
        const last = lines.length - 1;
        lines[last] = lines[last].replace("├─", "└─");
        // If last item is a running agent activity line, fix indent of that line
        // and fix the header line above it.
        if (runningLines.length > 0 && !queuedLine) {
          // The last two lines are the last running agent's header + activity.
          if (last >= 2) {
            lines[last - 1] = lines[last - 1].replace("├─", "└─");
            lines[last] = lines[last].replace("│  ", "   ");
          }
        }
      }
    } else {
      // Overflow — prioritize: running > queued > finished.
      // Reserve 1 line for overflow indicator.
      let budget = maxBody - 1;
      let hiddenRunning = 0;
      let hiddenFinished = 0;

      // 1. Running agents (2 lines each)
      for (const pair of runningLines) {
        if (budget >= 2) {
          lines.push(...pair);
          budget -= 2;
        } else {
          hiddenRunning++;
        }
      }

      // 2. Queued line
      if (queuedLine && budget >= 1) {
        lines.push(queuedLine);
        budget--;
      }

      // 3. Finished agents
      for (const fl of finishedLines) {
        if (budget >= 1) {
          lines.push(fl);
          budget--;
        } else {
          hiddenFinished++;
        }
      }

      // Overflow summary
      const overflowParts: string[] = [];
      if (hiddenRunning > 0) overflowParts.push(`${hiddenRunning} running`);
      if (hiddenFinished > 0) overflowParts.push(`${hiddenFinished} finished`);
      const overflowText = overflowParts.join(", ");
      lines.push(truncate(theme.fg("dim", "└─") + ` ${theme.fg("dim", `+${hiddenRunning + hiddenFinished} more (${overflowText})`)}`)
      );
    }

    return lines;
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const mode = this.mode();
    const allAgents = this.widgetAgents();
    const listed = this.manager.listAgents();

    // Lightweight existence checks — full categorization happens in renderWidget()
    let runningCount = 0;
    let queuedCount = 0;
    let hasFinished = false;
    for (const a of allAgents) {
      if (a.status === "running") { runningCount++; }
      else if (a.status === "queued") { queuedCount++; }
      else if (a.completedAt && this.shouldShowFinished(a.id, a.status)) { hasFinished = true; }
    }
    const hasActive = runningCount > 0 || queuedCount > 0;
    const widgetWantsShow = hasActive || hasFinished;

    // Status bar policy (auto):
    //   - Widget mode all/background and the tree is (or will be) visible → clear status
    //     (plain "1 running agent" fights the rich widget chrome).
    //   - Widget mode off → compact count is the sole bottom-bar indicator.
    //   - Nothing active → clear.
    let newStatusText: string | undefined;
    if (mode === "off") {
      let statusRunning = 0;
      let statusQueued = 0;
      for (const a of listed) {
        if (a.status === "running") statusRunning++;
        else if (a.status === "queued") statusQueued++;
      }
      newStatusText = formatSubagentsStatusText(statusRunning, statusQueued);
    } else {
      newStatusText = undefined;
    }
    if (newStatusText !== this.lastStatusText) {
      this.uiCtx.setStatus("subagents", newStatusText);
      this.lastStatusText = newStatusText;
    }

    // Nothing for the above-editor tree — drop the widget (status may still be live when mode=off).
    if (!widgetWantsShow) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("agents", undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      // Keep the timer while status fallback must refresh; stop otherwise.
      if (!(mode === "off" && newStatusText)) {
        if (this.widgetInterval) { clearInterval(this.widgetInterval); this.widgetInterval = undefined; }
      }
      // Clean up stale finished-age entries against the full list.
      for (const [id] of this.finishedTurnAge) {
        if (!listed.some(a => a.id === id)) this.finishedTurnAge.delete(id);
      }
      return;
    }

    this.widgetFrame++;

    // Register widget callback once; subsequent updates use requestRender()
    // which re-invokes render() without replacing the component (avoids layout thrashing).
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("agents", (tui, theme) => {
        this.tui = tui;
        return {
          render: () => this.renderWidget(tui, theme),
          invalidate: () => {
            // Theme changed — force re-registration so factory captures fresh theme.
            this.widgetRegistered = false;
            this.tui = undefined;
          },
        };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else {
      // Widget already registered — just request a re-render of existing components.
      this.tui?.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("agents", undefined);
      this.uiCtx.setStatus("subagents", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
  }
}
