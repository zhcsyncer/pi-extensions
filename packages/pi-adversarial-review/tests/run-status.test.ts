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
      "Adversarial review · preparing · 4 review routes · refute off · 0s",
    );
    status.update({ phase: "review", total: 4, queued: 1, running: 2, finished: 1 });
    expect(setStatus).toHaveBeenLastCalledWith(
      "adversarial-review",
      "Adversarial review · review 1/4 finished · 2 running · 1 queued · refute off · 0s",
    );

    vi.advanceTimersByTime(61_000);
    expect(setStatus).toHaveBeenLastCalledWith(
      "adversarial-review",
      "Adversarial review · review 1/4 finished · 2 running · 1 queued · refute off · 1m01s",
    );
    status.dispose();
    expect(setStatus).toHaveBeenLastCalledWith("adversarial-review", undefined);
    const calls = setStatus.mock.calls.length;
    vi.advanceTimersByTime(5_000);
    expect(setStatus).toHaveBeenCalledTimes(calls);
  });

  it("shows refute armed through review and switches to the refute phase", () => {
    vi.useFakeTimers();
    const { ctx, setStatus } = runContext();
    const status = createReviewRunStatus(ctx, 2, Date.now(), true);

    expect(setStatus).toHaveBeenLastCalledWith(
      "adversarial-review",
      expect.stringContaining("2 review routes · refute armed"),
    );
    status.update({ phase: "review", total: 2, queued: 0, running: 2, finished: 0 });
    expect(setStatus).toHaveBeenLastCalledWith(
      "adversarial-review",
      expect.stringContaining("review 0/2 finished · 2 running · 0 queued · refute armed"),
    );
    status.update({ phase: "refute", total: 1, queued: 0, running: 1, finished: 0 });
    expect(setStatus).toHaveBeenLastCalledWith(
      "adversarial-review",
      expect.stringContaining("refute 0/1 finished · 1 running · 0 queued"),
    );
    expect(setStatus.mock.calls.at(-1)?.[1]).not.toContain("refute armed");
    status.dispose();
  });

  it("requires explicit confirmation, keeps one work run, and awaits cleanup", async () => {
    const controller = new AbortController();
    const requestRender = vi.fn();
    let component: {
      render(width: number): string[];
      handleInput(data: string): void;
      dispose?: () => void;
    } | undefined;
    const custom = vi.fn(async (factory: any) => new Promise((resolve) => {
      component = factory(
        { requestRender },
        {
          bold: (text: string) => text,
          fg: (_color: string, text: string) => text,
        },
        {},
        (value: unknown) => {
          component?.dispose?.();
          resolve(value);
        },
      );
    }));
    const { ctx } = runContext({ custom });
    let markWorkStarted!: () => void;
    const workStarted = new Promise<void>((resolve) => { markWorkStarted = resolve; });
    let markCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { markCleanupStarted = resolve; });
    let releaseCleanup!: () => void;
    const cleanupAllowed = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const work = vi.fn(async () => {
      markWorkStarted();
      await new Promise<void>((resolve) => {
        if (controller.signal.aborted) resolve();
        else controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      markCleanupStarted();
      await cleanupAllowed;
      return "cancelled-cleanly";
    });

    let runResolved = false;
    const running = runWithTuiCancellation(ctx, controller, work)
      .then((value) => {
        runResolved = true;
        return value;
      });
    await workStarted;

    expect(component?.render(120).join("\n")).toContain("Esc opens cancellation options");
    component?.handleInput("\x1b");
    expect(controller.signal.aborted).toBe(false);
    component?.handleInput("\r"); // default Continue review
    expect(controller.signal.aborted).toBe(false);
    component?.handleInput("\x1b");
    component?.handleInput("\x1b"); // confirmation Escape also continues
    expect(controller.signal.aborted).toBe(false);
    component?.handleInput("\x1b");
    component?.handleInput("\x1b[B");
    component?.handleInput("\r");

    expect(controller.signal.aborted).toBe(true);
    expect(work).toHaveBeenCalledOnce();
    await cleanupStarted;
    expect(runResolved).toBe(false);
    releaseCleanup();

    await expect(running).resolves.toBe("cancelled-cleanly");
    expect(runResolved).toBe(true);
    expect(custom).toHaveBeenCalledOnce();
    expect(requestRender).toHaveBeenCalled();
  });

  it("lets external shutdown abort bypass confirmation but still awaits cleanup", async () => {
    const controller = new AbortController();
    let component: { handleInput(data: string): void; dispose?: () => void } | undefined;
    const custom = vi.fn(async (factory: any) => new Promise((resolve) => {
      component = factory(
        { requestRender: vi.fn() },
        {
          bold: (text: string) => text,
          fg: (_color: string, text: string) => text,
        },
        {},
        (value: unknown) => {
          component?.dispose?.();
          resolve(value);
        },
      );
    }));
    const { ctx } = runContext({ custom });
    let releaseCleanup!: () => void;
    const cleanupAllowed = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let markAborted!: () => void;
    const abortObserved = new Promise<void>((resolve) => { markAborted = resolve; });
    const running = runWithTuiCancellation(ctx, controller, async () => {
      await new Promise<void>((resolve) => {
        if (controller.signal.aborted) resolve();
        else controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      markAborted();
      await cleanupAllowed;
      return "shutdown-cleanly";
    });
    await vi.waitFor(() => expect(component).toBeDefined());
    component?.handleInput("\x1b"); // confirmation is visible

    let resolved = false;
    void running.then(() => { resolved = true; });
    controller.abort(new Error("Pi session shut down"));
    await abortObserved;
    expect(resolved).toBe(false);
    releaseCleanup();

    await expect(running).resolves.toBe("shutdown-cleanly");
    expect(custom).toHaveBeenCalledOnce();
  });
});
