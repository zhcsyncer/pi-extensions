import {
  BorderedLoader,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
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
): ReviewRunStatus {
  let progress: ReviewerFleetProgress | undefined;
  let disposed = false;

  const render = () => {
    if (disposed) return;
    const detail = progress
      ? `${progress.finished}/${progress.total} finished · ${progress.running} running · ` +
        `${progress.queued} queued`
      : `preparing · ${totalRoutes} routes`;
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
 * Keep Escape wired to the same AbortController used by freeze/fan-out/stop.
 * The loader owns only run-level cancellation; FleetView still owns route detail.
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
        "Running adversarial review. Subagents FleetView retains per-route detail.",
      );
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        removeAbortListener();
        done(undefined);
      };
      const onAbort = () => close();
      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
      loader.onAbort = () => {
        controller.abort(new Error("Adversarial review cancelled by user"));
      };

      workPromise = Promise.resolve().then(work);
      void workPromise.then(close, close);
      if (controller.signal.aborted) close();
      return loader;
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
