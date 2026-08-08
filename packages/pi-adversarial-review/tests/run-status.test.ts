import {
  initTheme,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createReviewRunStatus,
  runWithTuiCancellation,
} from "../src/ui/run-status.ts";

function runContext(overrides: Record<string, unknown> = {}) {
  const setStatus = vi.fn();
  const ctx = {
    mode: "tui",
    ui: {
      setStatus,
      ...overrides,
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, setStatus };
}

beforeAll(() => {
  initTheme("dark", false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("review run UI", () => {
  it("keeps one aggregate footer status and clears its timer on dispose", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { ctx, setStatus } = runContext();
    const status = createReviewRunStatus(ctx, 4, Date.now());

    expect(setStatus).toHaveBeenLastCalledWith(
      "adversarial-review",
      "Adversarial review · preparing · 4 routes · 0s",
    );
    status.update({ total: 4, queued: 1, running: 2, finished: 1 });
    expect(setStatus).toHaveBeenLastCalledWith(
      "adversarial-review",
      "Adversarial review · 1/4 finished · 2 running · 1 queued · 0s",
    );

    vi.advanceTimersByTime(61_000);
    expect(setStatus).toHaveBeenLastCalledWith(
      "adversarial-review",
      "Adversarial review · 1/4 finished · 2 running · 1 queued · 1m01s",
    );
    status.dispose();
    expect(setStatus).toHaveBeenLastCalledWith("adversarial-review", undefined);
    const calls = setStatus.mock.calls.length;
    vi.advanceTimersByTime(5_000);
    expect(setStatus).toHaveBeenCalledTimes(calls);
  });

  it("maps loader Escape to the shared controller and still awaits run cleanup", async () => {
    const controller = new AbortController();
    const requestRender = vi.fn();
    const custom = vi.fn(async (factory: any) => new Promise((resolve) => {
      let component: { handleInput(data: string): void; dispose?: () => void } | undefined;
      component = factory(
        { requestRender },
        { fg: (_color: string, text: string) => text },
        {},
        (value: unknown) => {
          component?.dispose?.();
          resolve(value);
        },
      );
      queueMicrotask(() => component?.handleInput("\x1b"));
    }));
    const { ctx } = runContext({ custom });
    const cleaned = vi.fn();

    const result = await runWithTuiCancellation(ctx, controller, async () => {
      await new Promise<void>((resolve) => {
        if (controller.signal.aborted) resolve();
        else controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      cleaned();
      return "cancelled-cleanly";
    });

    expect(result).toBe("cancelled-cleanly");
    expect(controller.signal.aborted).toBe(true);
    expect(cleaned).toHaveBeenCalledOnce();
    expect(custom).toHaveBeenCalledOnce();
  });
});
