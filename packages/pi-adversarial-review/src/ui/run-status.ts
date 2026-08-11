import {
  BorderedLoader,
  DynamicBorder,
  type ExtensionCommandContext,
  getSelectListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import type { ReviewerFleetProgress } from "../runtime/types.ts";

const STATUS_KEY = "adversarial-review";

function elapsedText(startedAtMs: number, nowMs = Date.now()): string {
  const seconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m${String(remainder).padStart(2, "0")}s` : `${remainder}s`;
}

export interface ReviewRunStatus {
  update(progress: ReviewerFleetProgress): void;
  dispose(): void;
}

/** Footer-only aggregate progress. Per-route details remain owned by Subagents FleetView. */
export function createReviewRunStatus(
  ctx: ExtensionCommandContext,
  totalRoutes: number,
  startedAtMs = Date.now(),
  refuteRequested = false,
): ReviewRunStatus {
  let progress: ReviewerFleetProgress | undefined;
  let disposed = false;

  const render = () => {
    if (disposed) return;
    const refuteState = refuteRequested ? "refute armed" : "refute off";
    const detail = progress
      ? `${progress.phase} ${progress.finished}/${progress.total} finished · ` +
        `${progress.running} running · ${progress.queued} queued` +
        `${progress.phase === "review" ? ` · ${refuteState}` : ""}`
      : `preparing · ${totalRoutes} review routes · ${refuteState}`;
    ctx.ui.setStatus(STATUS_KEY, `Adversarial review · ${detail} · ${elapsedText(startedAtMs)}`);
  };

  render();
  const timer = setInterval(render, 1000);
  timer.unref?.();

  return {
    update(next) {
      if (disposed) return;
      progress = { ...next };
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      ctx.ui.setStatus(STATUS_KEY, undefined);
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
        "Running adversarial review. Esc opens cancellation options. " +
          "Subagents FleetView retains per-route detail.",
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
