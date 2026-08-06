/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Default view (scheme A): dispatch prompt · one-line tool step summaries · final result.
 * Subscribes to session events for real-time streaming updates.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type Component, Input, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import type { Theme } from "./agent-widget.js";
import { type AgentActivity, buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatDuration, formatSessionTokens, getDisplayName, getPromptModeLabel } from "./agent-widget.js";
import {
  buildConversationBrief,
  formatStepLine,
  truncatePromptLines,
  type BriefStep,
} from "./conversation-brief.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
/** Height ceiling shared by the overlay's `maxHeight` and the viewer's internal viewport cap. */
export const VIEWPORT_HEIGHT_PCT = 70;

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
  private stopArmed = false;
  private keys: ViewerKeys;
  /** Steering composer — present while the user is typing a message to the agent. */
  private composer: Input | undefined;
  /** When true, step args/results expand beyond the one-line summary. Default off. */
  private expandDetails = false;

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    /** Abort the agent shown here. Omitted → no stop affordance (e.g. read-only history). */
    private onStop?: () => void,
    /** User keybindings from `ctx.ui.custom()`. Omitted → hardcoded defaults. */
    keybindings?: ViewerKeybindings,
    /** Send a steering message to the agent. Omitted → no compose affordance. */
    private onSteer?: (message: string) => void,
  ) {
    this.keys = createViewerKeys(keybindings);
    this.unsubscribe = session.subscribe(() => {
      if (this.closed) return;
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    // While composing a steer message, the input owns all keys (Enter sends,
    // Esc cancels — both wired in openComposer()). Editing keys flow through.
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    // Enter opens the steering composer (only while the agent can still be
    // steered) — then type + Enter sends, Esc or an empty submit returns. When
    // not steerable, fall through so the key still disarms a pending stop.
    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }

    // Toggle expanded tool detail (args + folded-away result bodies).
    if (data === "o" || data === "O") {
      this.expandDetails = !this.expandDetails;
      this.stopArmed = false;
      this.tui.requestRender();
      return;
    }

    // Stop/abort the agent (only while it can still be stopped). Two-press:
    // first "x" arms, second confirms — any other key disarms.
    if (matchesKey(data, "x")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (this.keys.scrollUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.pageUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (this.keys.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  render(width: number): string[] {
    if (width < 6) return []; // too narrow for any meaningful rendering
    const th = this.theme;
    const innerW = width - 4; // border + padding
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    // Header
    lines.push(hrTop);
    const name = getDisplayName(this.record.type);
    const modeLabel = getPromptModeLabel(this.record.type);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    const statusIcon = this.record.status === "running"
      ? th.fg("accent", "●")
      : this.record.status === "completed"
        ? th.fg("success", "✓")
        : this.record.status === "error"
          ? th.fg("error", "✗")
          : th.fg("dim", "○");
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);

    const headerParts: string[] = [duration];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    const tokens = getLifetimeTotal(this.activity?.lifetimeUsage);
    if (tokens > 0) {
      const percent = getSessionContextPercent(this.activity?.session);
      headerParts.push(formatSessionTokens(tokens, percent, th, this.record.compactionCount));
    }

    lines.push(row(
      `${statusIcon} ${th.bold(name)}${modeTag}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerParts.join(" · "))}`,
    ));
    const invocationLine = this.invocationLine();
    if (invocationLine) lines.push(row(invocationLine));
    lines.push(hrMid);

    // Content area — rebuild every render (live data, no cache needed)
    const contentLines = this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);

    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(visible[i] ?? ""));
    }

    // Footer
    lines.push(hrMid);
    if (this.composer) {
      // Composer row: the Input renders its own `> ` prompt and cursor.
      lines.push(row(this.composer.render(innerW)[0] ?? ""));
      const composeHint = th.fg("dim", "Enter send · Esc cancel");
      const composeLeft = th.fg("accent", "✎ steer");
      const composeGap = Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint));
      lines.push(row(composeLeft + " ".repeat(composeGap) + composeHint));
    } else {
      // Actions on the left, navigation on the right. The scroll hint keeps its
      // full key list so the less-obvious bindings stay discoverable; it leads
      // the right group so "Esc close" is the only part that truncates first.
      const sep = th.fg("dim", " · ");
      const actions: string[] = [];
      if (this.canSteer()) actions.push(th.fg("dim", "Enter steer"));
      if (this.isStoppable()) {
        actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : th.fg("dim", "x stop"));
      }
      actions.push(th.fg("dim", this.expandDetails ? "o fold" : "o detail"));
      const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn or Shift+↑↓ · Esc close");

      // Prepend the line-count/scroll-% readout only when there's spare width —
      // it's the first thing dropped so it never crowds out the hints.
      const scrollPct = contentLines.length <= viewportHeight
        ? "100%"
        : `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
      const count = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
      const withCount = [count, ...actions].join(sep);
      const footerLeft = visibleWidth(withCount) + visibleWidth(footerRight) + 1 <= innerW
        ? withCount
        : actions.join(sep);

      const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
      lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
    }
    lines.push(hrBot);

    return lines;
  }

  /** Stoppable only when a stop handler exists and the agent is still active. */
  private isStoppable(): boolean {
    return !!this.onStop && (this.record.status === "running" || this.record.status === "queued");
  }

  /** Steerable only when a steer handler exists and the agent is still active. */
  private canSteer(): boolean {
    return !!this.onSteer && (this.record.status === "running" || this.record.status === "queued");
  }

  /** Open the inline steering composer and route subsequent input to it. */
  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      if (message) this.onSteer?.(message);
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  invalidate(): void { /* no cached state to clear */ }

  dispose(): void {
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  private viewportHeight(): number {
    // Cap mirrors the overlay's maxHeight — otherwise the viewer would render
    // more lines than the overlay shows and clip the footer.
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    // The composer adds one row above the footer hint while it's open.
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0) + (this.composer ? 1 : 0);
  }

  private invocationLine(): string | undefined {
    const { modelName, tags } = buildInvocationTags(this.record.invocation);
    const parts = modelName ? [modelName, ...tags] : tags;
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`);
  }

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];

    const th = this.theme;
    const messages = this.session.messages as unknown as Parameters<typeof buildConversationBrief>[0];
    const lines: string[] = [];

    if (!messages || messages.length === 0) {
      lines.push(th.fg("dim", "(waiting for first message...)"));
      return lines.map((l) => truncateToWidth(l, width));
    }

    const brief = buildConversationBrief(messages);
    const section = (title: string) => {
      lines.push(th.bold(title));
    };

    // ── Prompt ──────────────────────────────────────────────────────────
    section("Prompt");
    if (brief.prompt) {
      const { lines: promptLines } = truncatePromptLines(brief.prompt);
      for (const raw of promptLines) {
        for (const line of wrapTextWithAnsi(raw, width)) {
          lines.push(line);
        }
      }
    } else {
      lines.push(th.fg("dim", "(no dispatch prompt yet)"));
    }

    for (const steer of brief.steers) {
      lines.push(th.fg("dim", "───"));
      lines.push(th.fg("accent", "Steer"));
      for (const line of wrapTextWithAnsi(steer.trim(), width)) {
        lines.push(line);
      }
    }

    // ── Steps ───────────────────────────────────────────────────────────
    lines.push("");
    section("Steps");
    if (brief.steps.length === 0) {
      if (this.record.status === "running") {
        lines.push(th.fg("dim", "(no tool calls yet)"));
      } else {
        lines.push(th.fg("dim", "(no tool steps)"));
      }
    } else {
      for (const step of brief.steps) {
        this.pushStepLines(lines, step, width, th);
      }
    }

    // ── Result ──────────────────────────────────────────────────────────
    lines.push("");
    section("Result");
    if (brief.result) {
      for (const line of wrapTextWithAnsi(brief.result.trim(), width)) {
        lines.push(line);
      }
    } else if (this.record.status === "running") {
      if (this.activity) {
        const act = describeActivity(this.activity.activeTools, this.activity.responseText);
        lines.push(truncateToWidth(th.fg("accent", "⠹ ") + th.fg("dim", act || "running…"), width));
      } else {
        lines.push(th.fg("dim", "(running…)"));
      }
    } else if (this.record.status === "error") {
      lines.push(th.fg("error", "(failed — no final assistant text)"));
    } else {
      lines.push(th.fg("dim", "(no final result text)"));
    }

    // Live activity footer while tools are mid-flight (even if a prior result text exists).
    if (this.record.status === "running" && this.activity && brief.result) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      if (act) {
        lines.push("");
        lines.push(truncateToWidth(th.fg("accent", "⠹ ") + th.fg("dim", act), width));
      }
    }

    return lines.map((l) => truncateToWidth(l, width));
  }

  private pushStepLines(lines: string[], step: BriefStep, width: number, th: Theme): void {
    const plain = formatStepLine(step, { includeResultNote: !this.expandDetails });
    const icon = plain.slice(0, 1);
    const rest = plain.slice(1);
    const coloredIcon =
      step.status === "completed"
        ? th.fg("success", icon)
        : step.status === "error"
          ? th.fg("error", icon)
          : th.fg("accent", icon);
    let main = coloredIcon + rest;
    if (!this.expandDetails && step.resultNote) {
      // Re-color the trailing note when present (formatStepLine already appended it).
      const noteIdx = main.lastIndexOf("  · ");
      if (noteIdx >= 0) {
        const head = main.slice(0, noteIdx);
        const note = main.slice(noteIdx + 4);
        const noteColor = step.isError ? "error" : "dim";
        main = head + th.fg("dim", "  · ") + th.fg(noteColor, note);
      }
    }
    lines.push(truncateToWidth(main, width));

    if (!this.expandDetails) return;

    if (step.argsText?.trim()) {
      for (const line of wrapTextWithAnsi(step.argsText.trim(), Math.max(1, width - 2))) {
        lines.push(truncateToWidth(th.fg("dim", `  ${line}`), width));
      }
    }
    if (step.resultText?.trim()) {
      const body = step.resultText.trim();
      const shown = body.length > 500 ? `${body.slice(0, 500)}... (truncated)` : body;
      const color = step.isError ? "error" : "dim";
      for (const line of wrapTextWithAnsi(shown, Math.max(1, width - 2))) {
        lines.push(truncateToWidth(th.fg(color, `  ${line}`), width));
      }
    } else if (step.resultNote) {
      lines.push(truncateToWidth(th.fg(step.isError ? "error" : "dim", `  ${step.resultNote}`), width));
    }
  }
}
