import {
  initTheme,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FrozenReviewInput } from "../src/types.ts";
import {
  createReviewRunStatus,
  runWithTuiCancellation,
} from "../src/ui/run-status.ts";

function runContext(overrides: Record<string, unknown> = {}) {
  const setStatus = vi.fn();
  const setWidget = vi.fn();
  const ctx = {
    mode: "tui",
    ui: {
      setStatus,
      setWidget,
      ...overrides,
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, setStatus, setWidget };
}

beforeAll(() => {
  initTheme("dark", false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("review run UI", () => {
  it("keeps aggregate progress and elapsed time in one widget and clears it on dispose", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { ctx, setStatus, setWidget } = runContext();
    const status = createReviewRunStatus(ctx, {
      totalRoutes: 4,
      targetSummary: "Adversarial review target: local changes.",
      startedAtMs: Date.now(),
    });
    const factory = setWidget.mock.calls[0]?.[1] as (
      tui: { requestRender(): void },
      theme: { bold(text: string): string; fg(color: string, text: string): string },
    ) => { render(width: number): string[] };
    const component = factory(
      { requestRender: vi.fn() },
      { bold: (text) => text, fg: (_color, text) => text },
    );

    expect(component.render(180).join("\n")).toContain(
      "Adversarial Review · ● Preparing · 4 reviewers · 0s",
    );
    expect(setStatus).not.toHaveBeenCalled();
    expect(setWidget).toHaveBeenCalledWith(
      "adversarial-review-run",
      expect.any(Function),
      { placement: "aboveEditor" },
    );
    status.update({
      phase: "review",
      total: 4,
      queued: 1,
      running: 2,
      finished: 1,
      items: [],
    });
    expect(component.render(180).join("\n")).toContain(
      "Adversarial Review · ● Review · 1/4 complete · 2 running · 1 queued · 0s",
    );

    vi.advanceTimersByTime(61_000);
    expect(component.render(180).join("\n")).toContain(
      "Adversarial Review · ● Review · 1/4 complete · 2 running · 1 queued · 1m01s",
    );
    status.dispose();
    expect(setWidget).toHaveBeenLastCalledWith("adversarial-review-run", undefined);
    const calls = setWidget.mock.calls.length;
    vi.advanceTimersByTime(5_000);
    expect(setWidget).toHaveBeenCalledTimes(calls);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("mentions Refute only after the Refute phase actually starts", () => {
    vi.useFakeTimers();
    const { ctx, setStatus, setWidget } = runContext();
    const status = createReviewRunStatus(ctx, {
      totalRoutes: 2,
      targetSummary: "Adversarial review target: base origin/main.",
    });
    const factory = setWidget.mock.calls[0]?.[1] as (
      tui: { requestRender(): void },
      theme: { bold(text: string): string; fg(color: string, text: string): string },
    ) => { render(width: number): string[] };
    const component = factory(
      { requestRender: vi.fn() },
      { bold: (text) => text, fg: (_color, text) => text },
    );

    expect(component.render(180).join("\n")).not.toContain("Refute");
    status.update({
      phase: "review",
      total: 2,
      queued: 0,
      running: 2,
      finished: 0,
      items: [],
    });
    const reviewCard = component.render(180).join("\n");
    expect(reviewCard).toContain("Review · 0/2 complete · 2 running");
    expect(reviewCard).not.toContain("Refute");
    status.update({
      phase: "refute",
      total: 1,
      queued: 0,
      running: 1,
      finished: 0,
      items: [],
    });
    expect(component.render(180).join("\n")).toContain(
      "Refute · 0/1 complete · 1 running",
    );
    status.dispose();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("keeps external agent detail in FleetView while rendering target and deterministic outcomes", () => {
    vi.useFakeTimers();
    const { ctx, setWidget } = runContext();
    const status = createReviewRunStatus(ctx, {
      totalRoutes: 2,
      targetSummary: "Adversarial review target: local changes.",
    });
    const factory = setWidget.mock.calls[0]?.[1] as (
      tui: { requestRender(): void },
      theme: { bold(text: string): string; fg(color: string, text: string): string },
    ) => { render(width: number): string[] };
    const component = factory(
      { requestRender: vi.fn() },
      { bold: (text) => text, fg: (_color, text) => text },
    );

    expect(component.render(180).join("\n")).toContain(
      "Flow · ● Snapshot ─ ○ Review ─ ○ Gate ─ ○ Finish",
    );
    status.runtime("external-v3");
    status.frozen({
      target: {
        description: "local changes at HEAD abc123",
        changedFiles: ["src/a.ts", "src/b.ts"],
      },
      inputSize: { bytes: 61_440, lines: 824 },
    } as FrozenReviewInput);
    status.update({
      phase: "review",
      total: 2,
      queued: 0,
      running: 0,
      finished: 2,
      items: [
        {
          kind: "reviewer",
          routeKey: "provider-a/model-a@high",
          status: "completed",
          verdict: "approve",
          findingCount: 0,
        },
        {
          kind: "reviewer",
          routeKey: "provider-b/model-b@high",
          status: "invalid-output",
        },
      ],
    });
    const reviewCard = component.render(180).join("\n");
    expect(reviewCard).toContain("Flow · ✓ Snapshot ─ ● Review ─ ○ Gate ─ ○ Finish");
    expect(reviewCard).toContain("Target · local changes at HEAD abc123");
    expect(reviewCard).toContain("Input · 60.0 KiB · 824 lines · 2 files");
    expect(reviewCard).not.toContain("provider-a/model-a@high");
    expect(reviewCard).not.toContain("provider-b/model-b@high");
    expect(reviewCard).not.toContain("invalid output");

    status.gate({
      gating: "weighted",
      overall: "needs-adjudication",
      validReviewers: 1,
      totalReviewers: 2,
      blocking: 1,
      advisory: 2,
    });
    expect(component.render(180).join("\n")).toContain(
      "Flow · ✓ Snapshot ─ ✓ Review ─ ● Gate ─ ○ Finish",
    );
    status.update({
      phase: "refute",
      total: 1,
      queued: 0,
      running: 1,
      finished: 0,
      items: [],
    });
    expect(component.render(180).join("\n")).toContain(
      "Flow · ✓ Snapshot ─ ✓ Review ─ ! Gate ─ ● Refute ─ ○ Finish",
    );
    status.refute({ state: "completed", valid: 1, total: 1, contested: 1 });
    status.publishing();
    const publishedCard = component.render(180).join("\n");
    expect(publishedCard).toContain(
      "Flow · ✓ Snapshot ─ ✓ Review ─ ! Gate ─ ✓ Refute ─ ● Finish",
    );
    expect(publishedCard).toContain(
      "Gate · weighted · needs-adjudication · 1/2 valid · 1 blocking · 2 advisory",
    );
    expect(publishedCard).toContain("Refute · 1/1 valid · 1 contested");

    status.cleanup("retained");
    const retainedCard = component.render(180).join("\n");
    expect(retainedCard).toContain(
      "Flow · ✓ Snapshot ─ ✓ Review ─ ! Gate ─ ✓ Refute ─ ! Finish",
    );
    expect(retainedCard).toContain("resources retained for safety");
    status.dispose();
  });

  it("finishes without inserting a Refute node when Refute never starts", () => {
    const { ctx, setWidget } = runContext();
    const status = createReviewRunStatus(ctx, {
      totalRoutes: 2,
      targetSummary: "Adversarial review target: local changes.",
    });
    const factory = setWidget.mock.calls[0]?.[1] as (
      tui: { requestRender(): void },
      theme: { bold(text: string): string; fg(color: string, text: string): string },
    ) => { render(width: number): string[] };
    const component = factory(
      { requestRender: vi.fn() },
      { bold: (text) => text, fg: (_color, text) => text },
    );

    status.runtime("external-v3");
    status.update({
      phase: "review",
      total: 2,
      queued: 0,
      running: 0,
      finished: 2,
      items: [],
    });
    status.gate({
      gating: "weighted",
      overall: "candidate-approve",
      validReviewers: 2,
      totalReviewers: 2,
      blocking: 0,
      advisory: 0,
    });
    status.refute({ state: "skipped", reason: "no-blocking", overall: "candidate-approve" });
    status.publishing();

    const publishingCard = component.render(180).join("\n");
    expect(publishingCard).toContain(
      "Flow · ✓ Snapshot ─ ✓ Review ─ ✓ Gate ─ ● Finish",
    );
    expect(publishingCard).not.toContain("○ Refute");
    expect(publishingCard).toContain("Refute · skipped · no blocking findings");

    status.cleanup("completed");
    expect(component.render(180).join("\n")).toContain(
      "Flow · ✓ Snapshot ─ ✓ Review ─ ✓ Gate ─ ✓ Finish",
    );
    status.dispose();
  });

  it("marks the failed lifecycle node while cleanup remains the active finish barrier", () => {
    const { ctx, setWidget } = runContext();
    const status = createReviewRunStatus(ctx, {
      totalRoutes: 2,
      targetSummary: "Adversarial review target: local changes.",
    });
    const factory = setWidget.mock.calls[0]?.[1] as (
      tui: { requestRender(): void },
      theme: { bold(text: string): string; fg(color: string, text: string): string },
    ) => { render(width: number): string[] };
    const component = factory(
      { requestRender: vi.fn() },
      { bold: (text) => text, fg: (_color, text) => text },
    );

    status.runtime("external-v3");
    status.update({
      phase: "review",
      total: 2,
      queued: 0,
      running: 1,
      finished: 1,
      items: [],
    });
    status.failed();
    expect(component.render(180).join("\n")).toContain(
      "Flow · ✓ Snapshot ─ × Review ─ ○ Gate ─ ○ Finish",
    );

    status.cleanup("running");
    expect(component.render(180).join("\n")).toContain(
      "Flow · ✓ Snapshot ─ × Review ─ ○ Gate ─ ● Finish",
    );
    status.cleanup("retained");
    expect(component.render(180).join("\n")).toContain(
      "Flow · ✓ Snapshot ─ × Review ─ ○ Gate ─ ! Finish",
    );
    status.dispose();
  });

  it("keeps the compact card bounded at narrow, normal, and wide terminal widths", () => {
    const { ctx, setWidget } = runContext();
    const status = createReviewRunStatus(ctx, {
      totalRoutes: 8,
      targetSummary:
        "Adversarial review target: committed changes from origin/main through HEAD, plus local changes on a very long feature branch.",
    });
    const factory = setWidget.mock.calls[0]?.[1] as (
      tui: { requestRender(): void },
      theme: { bold(text: string): string; fg(color: string, text: string): string },
    ) => { render(width: number): string[] };
    const component = factory(
      { requestRender: vi.fn() },
      { bold: (text) => text, fg: (_color, text) => text },
    );
    status.runtime("external-v3");
    status.update({
      phase: "review",
      total: 8,
      queued: 3,
      running: 4,
      finished: 1,
      items: [],
    });

    for (const width of [60, 80, 120]) {
      const lines = component.render(width);
      expect(lines).toHaveLength(4);
      expect(lines[0]).toContain("Adversarial Review");
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    status.dispose();
  });

  it("retains per-agent visibility when the embedded fallback has no FleetView", () => {
    const { ctx, setWidget } = runContext();
    const status = createReviewRunStatus(ctx, {
      totalRoutes: 2,
      targetSummary: "Adversarial review target: local changes.",
    });
    const factory = setWidget.mock.calls[0]?.[1] as (
      tui: { requestRender(): void },
      theme: { bold(text: string): string; fg(color: string, text: string): string },
    ) => { render(width: number): string[] };
    const component = factory(
      { requestRender: vi.fn() },
      { bold: (text) => text, fg: (_color, text) => text },
    );

    status.runtime("embedded");
    status.update({
      phase: "review",
      total: 2,
      queued: 0,
      running: 1,
      finished: 1,
      items: [
        {
          kind: "reviewer",
          routeKey: "provider-a/model-a@high",
          status: "completed",
          verdict: "approve",
          findingCount: 0,
        },
        {
          kind: "reviewer",
          routeKey: "provider-b/model-b@high",
          status: "running",
        },
      ],
    });

    const card = component.render(180).join("\n");
    expect(card).toContain("provider-a/model-a@high · approve");
    expect(card).toContain("provider-b/model-b@high");
    expect(card).not.toContain("lens");
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
