import {
  BorderedLoader,
  DynamicBorder,
  type ExtensionCommandContext,
  getSelectListTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { safeReviewDiagnosticText } from "../output/headless-output.ts";
import type {
  ReviewerFleetItemProgress,
  ReviewerFleetProgress,
  ReviewRuntimeBackend,
} from "../runtime/types.ts";
import type {
  FrozenReviewInput,
  GatingMode,
  MergedReviewReport,
} from "../types.ts";

const WIDGET_KEY = "adversarial-review-run";
const MAX_CARD_LINES = 10;

function elapsedText(startedAtMs: number, nowMs = Date.now()): string {
  const seconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m${String(remainder).padStart(2, "0")}s` : `${remainder}s`;
}

function oneLine(value: string): string {
  return safeReviewDiagnosticText(value).replace(/\s+/gu, " ").trim();
}

function compactTargetSummary(summary: string): string {
  return oneLine(summary)
    .replace(/^Adversarial review target:\s*/u, "")
    .replace(/\.$/u, "");
}

function compactFrozenTarget(description: string): string {
  return oneLine(description)
    .replace(/\b([0-9a-f]{7})[0-9a-f]{33,57}\b/gu, "$1")
    .replace(/\b([0-9a-f]{7}) \(\1\)/gu, "$1");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export interface ReviewRunGateSummary {
  gating: GatingMode;
  overall: MergedReviewReport["overall"];
  validReviewers: number;
  totalReviewers: number;
  blocking: number;
  advisory: number;
}

export type ReviewRunRefuteSummary =
  | { state: "disabled" }
  | {
      state: "skipped";
      reason: "no-blocking" | "review-ineligible" | "no-route";
      overall: MergedReviewReport["overall"];
    }
  | { state: "completed"; valid: number; total: number; contested: number };

export interface CreateReviewRunStatusOptions {
  totalRoutes: number;
  targetSummary: string;
  startedAtMs?: number;
}

export interface ReviewRunStatus {
  runtime(backend: ReviewRuntimeBackend): void;
  update(progress: ReviewerFleetProgress): void;
  frozen(input: FrozenReviewInput): void;
  gate(summary: ReviewRunGateSummary): void;
  refute(summary: ReviewRunRefuteSummary): void;
  publishing(): void;
  cleanup(state: "running" | "completed" | "retained"): void;
  failed(): void;
  dispose(): void;
}

type ReviewRunStage =
  | "preparing"
  | "review"
  | "gating"
  | "refute"
  | "publishing"
  | "cleanup"
  | "failed";

type ReviewFlowNode = "snapshot" | "review" | "gate" | "refute" | "finish";
type ReviewFlowNodeState = "completed" | "active" | "pending" | "failed" | "warning";

const FLOW_NODE_LABELS: Record<ReviewFlowNode, string> = {
  snapshot: "Snapshot",
  review: "Review",
  gate: "Gate",
  refute: "Refute",
  finish: "Finish",
};

interface FrozenDisplay {
  description: string;
  bytes: number;
  lines: number;
  files: number;
}

function copyProgress(progress: ReviewerFleetProgress): ReviewerFleetProgress {
  return {
    ...progress,
    items: progress.items.map((item) => ({ ...item })),
  };
}

function itemStatus(item: ReviewerFleetItemProgress, theme: Theme): string {
  if (item.status === "queued") return theme.fg("dim", "○ queued");
  if (item.status === "running") return theme.fg("accent", "● running");
  if (item.status === "completed") return theme.fg("success", "✓ valid");
  if (item.status === "cancelled") return theme.fg("warning", "– cancelled");
  if (item.status === "timed-out") return theme.fg("warning", "! timed out");
  if (item.status === "invalid-output") return theme.fg("error", "× invalid output");
  return theme.fg("error", "× errored");
}

function renderFleetItem(
  item: ReviewerFleetItemProgress,
  width: number,
  theme: Theme,
): string {
  const route = oneLine(item.routeKey);
  let detail: string;
  if (item.kind === "reviewer") {
    const outcome = item.verdict === "approve"
      ? " · approve"
      : item.verdict === "needs-attention"
        ? ` · needs attention (${item.findingCount ?? 0})`
        : "";
    detail = `${route}${outcome}`;
  } else {
    const outcome = item.refuted === true
      ? " · challenge supported"
      : item.refuted === false ? " · finding survives" : "";
    detail = `finding #${item.findingIndex + 1} · ${route}${outcome}`;
  }
  return truncateToWidth(`  ${itemStatus(item, theme)} · ${detail}`, width);
}

function appendFleetItems(
  lines: string[],
  items: readonly ReviewerFleetItemProgress[],
  width: number,
  theme: Theme,
): void {
  const available = Math.max(0, MAX_CARD_LINES - lines.length);
  if (items.length <= available) {
    lines.push(...items.map((item) => renderFleetItem(item, width, theme)));
    return;
  }
  const visible = Math.max(0, available - 1);
  lines.push(...items.slice(0, visible).map((item) => renderFleetItem(item, width, theme)));
  lines.push(truncateToWidth(
    `  ${theme.fg("dim", `… ${items.length - visible} more; see final report`)}`,
    width,
  ));
}

/**
 * Ephemeral run-level visibility. This card owns aggregate progress and
 * deterministic Review state. External Subagents owns per-agent detail,
 * while embedded fallback renders bounded agent rows here. No intermediate UI
 * text is appended to model context.
 */
export function createReviewRunStatus(
  ctx: ExtensionCommandContext,
  options: CreateReviewRunStatusOptions,
): ReviewRunStatus {
  const startedAtMs = options.startedAtMs ?? Date.now();
  let stage: ReviewRunStage = "preparing";
  let backend: ReviewRuntimeBackend | undefined;
  let progress: ReviewerFleetProgress | undefined;
  let refuteStarted = false;
  let failedNode: ReviewFlowNode | undefined;
  let frozen: FrozenDisplay | undefined;
  let gate: ReviewRunGateSummary | undefined;
  let refute: ReviewRunRefuteSummary | undefined;
  let cleanupState: "running" | "completed" | "retained" | undefined;
  let disposed = false;
  let widgetRegistered = false;
  let widgetTui: { requestRender(): void } | undefined;

  const fleetProgress = (phase: "Review" | "Refute", value: ReviewerFleetProgress) => {
    const running = value.running > 0 ? ` · ${value.running} running` : "";
    const queued = value.queued > 0 ? ` · ${value.queued} queued` : "";
    return `${phase} · ${value.finished}/${value.total} complete${running}${queued}`;
  };

  const stageDetail = () => {
    if (stage === "review" && progress?.phase === "review") {
      return fleetProgress("Review", progress);
    }
    if (stage === "refute" && progress?.phase === "refute") {
      return fleetProgress("Refute", progress);
    }
    if (stage === "gating") return "Gating findings";
    if (stage === "publishing" && gate) {
      return `${gate.overall} · ${gate.validReviewers}/${gate.totalReviewers} valid`;
    }
    if (stage === "publishing") return "Publishing report";
    if (stage === "cleanup") {
      if (cleanupState === "completed") return "Cleanup complete";
      if (cleanupState === "retained") return "Cleanup retained resources";
      return "Cleaning up";
    }
    if (stage === "failed") return "Failed";
    return `Preparing · ${options.totalRoutes} reviewers`;
  };

  const activeFlowNode = (): ReviewFlowNode => {
    if (stage === "review") return "review";
    if (stage === "gating") return "gate";
    if (stage === "refute") {
      return refute?.state === "completed" ? "finish" : "refute";
    }
    if (stage === "publishing" || stage === "cleanup") return "finish";
    if (stage === "failed") return failedNode ?? "snapshot";
    return "snapshot";
  };

  const flowNodeState = (
    node: ReviewFlowNode,
    nodes: readonly ReviewFlowNode[],
  ): ReviewFlowNodeState => {
    const active = activeFlowNode();
    const nodeIndex = nodes.indexOf(node);
    const activeIndex = nodes.indexOf(active);
    const failedIndex = failedNode ? nodes.indexOf(failedNode) : -1;

    if (node === failedNode) return "failed";
    if (node === "finish" && stage === "cleanup") {
      if (cleanupState === "completed") return "completed";
      if (cleanupState === "retained") return "warning";
      return "active";
    }
    if (failedIndex >= 0 && active === "finish" && nodeIndex > failedIndex && node !== "finish") {
      return "pending";
    }
    if (nodeIndex < activeIndex) {
      if (node === "gate" && gate && gate.overall !== "candidate-approve") return "warning";
      return "completed";
    }
    if (node === active) return stage === "failed" ? "failed" : "active";
    return "pending";
  };

  const flowNodeText = (
    node: ReviewFlowNode,
    state: ReviewFlowNodeState,
    theme: Theme,
  ): string => {
    const label = FLOW_NODE_LABELS[node];
    if (state === "completed") return theme.fg("success", `✓ ${label}`);
    if (state === "active") return theme.fg("accent", `● ${label}`);
    if (state === "failed") return theme.fg("error", `× ${label}`);
    if (state === "warning") return theme.fg("warning", `! ${label}`);
    return theme.fg("dim", `○ ${label}`);
  };

  const headerLine = (width: number, theme: Theme) => {
    const failed = stage === "failed";
    const warning = cleanupState === "retained" ||
      (stage === "publishing" && gate?.overall !== "candidate-approve");
    const icon = failed ? "×" : warning ? "!" : "●";
    const color = failed ? "error" : warning ? "warning" : "accent";
    return truncateToWidth(
      `  ${theme.bold("Adversarial Review")} · ${theme.fg(color, `${icon} ${stageDetail()}`)} · ` +
        theme.fg("dim", elapsedText(startedAtMs)),
      width,
    );
  };

  const flowLine = (width: number, theme: Theme) => {
    const nodes: ReviewFlowNode[] = ["snapshot", "review", "gate"];
    if (refuteStarted) nodes.push("refute");
    nodes.push("finish");
    const flow = nodes
      .map((node) => flowNodeText(node, flowNodeState(node, nodes), theme))
      .join(theme.fg("dim", " ─ "));
    return truncateToWidth(`  ${theme.fg("muted", "Flow")} · ${flow}`, width);
  };

  const targetLine = (width: number, theme: Theme) => truncateToWidth(
    `  ${theme.fg("muted", "Target")} · ${frozen?.description ?? compactTargetSummary(options.targetSummary)}`,
    width,
  );

  const snapshotLine = (width: number, theme: Theme) => {
    const detail = frozen
      ? `${formatBytes(frozen.bytes)} · ${frozen.lines} lines · ${frozen.files} files`
      : "freezing deterministic input";
    return truncateToWidth(`  ${theme.fg("muted", "Input")} · ${detail}`, width);
  };

  const gateLine = (width: number, theme: Theme) => gate
    ? truncateToWidth(
        `  ${theme.fg("muted", "Gate")} · ${gate.gating} · ${gate.overall} · ` +
          `${gate.validReviewers}/${gate.totalReviewers} valid · ` +
          `${gate.blocking} blocking · ${gate.advisory} advisory`,
        width,
      )
    : undefined;

  const refuteLine = (width: number, theme: Theme) => {
    let detail: string;
    if (refute?.state === "completed") {
      detail = `${refute.valid}/${refute.total} valid · ${refute.contested} contested`;
    } else if (refute?.state === "disabled") {
      detail = "disabled";
    } else if (refute?.state === "skipped") {
      detail = refute.reason === "no-blocking"
        ? "skipped · no blocking findings"
        : refute.reason === "no-route"
          ? "skipped · no compatible route"
          : `skipped · review ended ${refute.overall}`;
    } else {
      detail = "disabled";
    }
    return truncateToWidth(`  ${theme.fg("muted", "Refute")} · ${detail}`, width);
  };

  const renderCard = (width: number, theme: Theme): string[] => {
    const lines = [
      headerLine(width, theme),
      flowLine(width, theme),
      targetLine(width, theme),
      snapshotLine(width, theme),
    ];
    if (stage === "review" && progress?.phase === "review") {
      if (backend === "embedded") appendFleetItems(lines, progress.items, width, theme);
      return lines;
    }
    if (stage === "refute" && progress?.phase === "refute") {
      const renderedGate = gateLine(width, theme);
      if (renderedGate) lines.push(renderedGate);
      if (backend === "embedded") appendFleetItems(lines, progress.items, width, theme);
      if (refute?.state === "completed") lines.push(refuteLine(width, theme));
      return lines;
    }
    const renderedGate = gateLine(width, theme);
    if (renderedGate) lines.push(renderedGate);
    if (refute && refute.state !== "disabled") lines.push(refuteLine(width, theme));
    if (stage === "cleanup") {
      const cleanupText = cleanupState === "retained"
        ? "resources retained for safety"
        : cleanupState === "completed" ? "complete" : "stopping runtime and removing frozen input";
      lines.push(truncateToWidth(
        `  ${theme.fg("muted", "Cleanup")} · ${cleanupText}`,
        width,
      ));
    }
    return lines.slice(0, MAX_CARD_LINES);
  };

  const registerWidget = () => {
    if (disposed || widgetRegistered) return;
    try {
      ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        widgetTui = tui;
        return {
          render: (width: number) => renderCard(width, theme),
          invalidate: () => {
            widgetRegistered = false;
            widgetTui = undefined;
          },
        };
      }, { placement: "aboveEditor" });
      widgetRegistered = true;
    } catch {
      // The running input control remains available if widgets are unavailable.
    }
  };

  const render = () => {
    if (disposed) return;
    registerWidget();
    try {
      widgetTui?.requestRender();
    } catch {
      // A stale TUI component will be replaced on the next refresh.
      widgetRegistered = false;
      widgetTui = undefined;
    }
  };

  render();
  const timer = setInterval(render, 1000);
  timer.unref?.();

  return {
    runtime(next) {
      if (disposed) return;
      backend = next;
      render();
    },
    update(next) {
      if (disposed) return;
      progress = copyProgress(next);
      if (next.phase === "refute") refuteStarted = true;
      stage = next.phase;
      render();
    },
    frozen(input) {
      if (disposed) return;
      frozen = {
        description: compactFrozenTarget(input.target.description),
        bytes: input.inputSize.bytes,
        lines: input.inputSize.lines,
        files: input.target.changedFiles.length,
      };
      render();
    },
    gate(next) {
      if (disposed) return;
      gate = { ...next };
      stage = "gating";
      render();
    },
    refute(next) {
      if (disposed) return;
      refute = { ...next };
      render();
    },
    publishing() {
      if (disposed) return;
      stage = "publishing";
      render();
    },
    cleanup(next) {
      if (disposed) return;
      cleanupState = next;
      stage = "cleanup";
      render();
    },
    failed() {
      if (disposed) return;
      failedNode = activeFlowNode();
      stage = "failed";
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      widgetRegistered = false;
      widgetTui = undefined;
      try {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
      } catch {
        // The session may already be tearing down.
      }
    },
  };
}

/**
 * Keep one running loader while Escape opens an explicit cancellation choice.
 * External aborts (including session shutdown) bypass confirmation and close the
 * UI immediately, while the returned promise still waits for real cleanup.
 */
export async function runWithTuiCancellation<T>(
  ctx: ExtensionCommandContext,
  controller: AbortController,
  work: () => Promise<T>,
): Promise<T> {
  let workPromise: Promise<T> | undefined;
  let removeAbortListener = () => {};

  try {
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const loader = new BorderedLoader(
        tui,
        theme,
        "Review running · input paused · Esc opens cancellation options.",
        { cancellable: false },
      );
      const choices: SelectItem[] = [
        {
          value: "continue",
          label: "Continue review",
          description: "Return to the current running review.",
        },
        {
          value: "cancel",
          label: "Confirm cancellation",
          description: "Stop freezing or all active reviewer/refuter routes.",
        },
      ];
      const confirmation = new Container();
      const borderColor = (text: string) => theme.fg("border", text);
      confirmation.addChild(new DynamicBorder(borderColor));
      confirmation.addChild(new Text(
        theme.fg("warning", theme.bold("Cancel the running adversarial review?")),
        1,
        0,
      ));
      const selectList = new SelectList(choices, choices.length, getSelectListTheme());
      confirmation.addChild(selectList);
      confirmation.addChild(new Text(
        theme.fg("dim", "↑↓ navigate • enter select • esc continue review"),
        1,
        0,
      ));
      confirmation.addChild(new DynamicBorder(borderColor));

      let mode: "running" | "confirm" = "running";
      let closed = false;
      const showRunning = () => {
        mode = "running";
        tui.requestRender();
      };
      const showConfirmation = () => {
        selectList.setSelectedIndex(0);
        mode = "confirm";
        tui.requestRender();
      };
      selectList.onSelect = (item) => {
        if (item.value === "continue") {
          showRunning();
          return;
        }
        controller.abort(new Error("Adversarial review cancelled by user"));
      };
      selectList.onCancel = showRunning;

      const close = () => {
        if (closed) return;
        closed = true;
        removeAbortListener();
        done(undefined);
      };
      const onAbort = () => close();
      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);

      workPromise = Promise.resolve().then(work);
      void workPromise.then(close, close);
      if (controller.signal.aborted) close();
      return {
        render: (width: number) => (
          mode === "running" ? loader.render(width) : confirmation.render(width)
        ),
        handleInput: (data: string) => {
          if (mode === "running") {
            if (matchesKey(data, "escape")) showConfirmation();
            return;
          }
          selectList.handleInput(data);
          tui.requestRender();
        },
        invalidate: () => {
          loader.invalidate();
          confirmation.invalidate();
        },
        dispose: () => loader.dispose(),
      };
    });
  } catch (error) {
    controller.abort(error);
    if (workPromise) await Promise.allSettled([workPromise]);
    throw error;
  } finally {
    removeAbortListener();
  }

  if (!workPromise) throw new Error("Adversarial review run UI did not start work.");
  return workPromise;
}
