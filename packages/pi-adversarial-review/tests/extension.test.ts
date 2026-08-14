import { execFile } from "node:child_process";
import { access, appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Model } from "@earendil-works/pi-ai";
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const freezeHooks = vi.hoisted(() => ({
  intercept: undefined as undefined | ((options: { signal?: AbortSignal }) => Promise<never>),
}));

const workspaceHooks = vi.hoisted(() => ({
  created: [] as Array<{ cleanup(): Promise<void> }>,
}));

vi.mock("../src/input/temp-workspace.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/input/temp-workspace.ts")>();
  return {
    ...actual,
    createReviewTempWorkspace: async (...args: Parameters<typeof actual.createReviewTempWorkspace>) => {
      const workspace = await actual.createReviewTempWorkspace(...args);
      workspaceHooks.created.push(workspace);
      return workspace;
    },
  };
});

vi.mock("../src/preflight/resolve-preflight.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/preflight/resolve-preflight.ts")>();
  return {
    ...actual,
    resolveReviewPreflight: vi.fn(async ({ target, allowLarge }: { target: any; allowLarge?: boolean }) => ({
      target,
      audit: { selection: "explicit", fetchStatus: "not-needed" },
      summary: "Adversarial review target: test-local.",
      inputSize: allowLarge ? { bytes: 300 * 1024, lines: 6_000 } : { bytes: 1024, lines: 20 },
      largeInput: allowLarge === true,
      guard: {},
    })),
    revalidateReviewPreflight: vi.fn(async () => true),
  };
});

vi.mock("../src/input/freeze-input.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/input/freeze-input.ts")>();
  return {
    ...actual,
    prepareFrozenReviewInput: (options: Parameters<typeof actual.prepareFrozenReviewInput>[0]) =>
      freezeHooks.intercept?.(options) ?? actual.prepareFrozenReviewInput(options),
  };
});

vi.mock("../src/output/audit-store.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/output/audit-store.ts")>();
  return {
    ...actual,
    persistStandaloneAudit: vi.fn(() => "/tmp/adversarial-review-test-audit.json"),
  };
});

import adversarialReviewExtension, {
  ADVERSARIAL_REVIEW_COMMAND,
  preflightReviewCommand,
} from "../src/index.ts";
import { ReviewInputCleanupError, ReviewInputError } from "../src/input/errors.ts";
import { persistStandaloneAudit } from "../src/output/audit-store.ts";
import type { ResolvedReviewPreflight } from "../src/preflight/resolve-preflight.ts";
import { EmbeddedReviewRuntime } from "../src/runtime/embedded-runtime.ts";
import { PiSubagentRpcV3Client } from "../src/runtime/rpc-v3-client.ts";

class FakePi {
  readonly commands = new Map<string, any>();
  readonly handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  readonly eventHandlers = new Map<string, Set<(data: any) => void>>();
  readonly emitted: Array<{ event: string; data: any }> = [];
  readonly sentMessages: Array<{ message: any; options: any }> = [];
  readonly entries: Array<{ customType: string; data: any }> = [];
  readonly registerTool = vi.fn();
  readonly registerMessageRenderer = vi.fn();
  readonly registerEntryRenderer = vi.fn();
  eventResponder?: (event: string, data: any) => void;
  readonly events = {
    on: (event: string, handler: (data: any) => void) => {
      const handlers = this.eventHandlers.get(event) ?? new Set();
      handlers.add(handler);
      this.eventHandlers.set(event, handlers);
      return () => handlers.delete(handler);
    },
    emit: (event: string, data: any) => {
      this.emitted.push({ event, data });
      this.eventResponder?.(event, data);
      for (const handler of this.eventHandlers.get(event) ?? []) handler(data);
    },
  };

  registerCommand(name: string, command: unknown): void {
    this.commands.set(name, command);
  }

  on(name: string, handler: (...args: any[]) => unknown): void {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }

  sendMessage(message: any, options: any): void {
    this.sentMessages.push({ message, options });
  }

  appendEntry(customType: string, data: any): void {
    this.entries.push({ customType, data });
  }

  entry(customType: string): { customType: string; data: any } | undefined {
    return this.entries.find((entry) => entry.customType === customType);
  }

  api(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}

function model(provider: string, id: string): Model<any> {
  return { provider, id, reasoning: true } as Model<any>;
}

const exec = promisify(execFile);
const tempRepos: string[] = [];
const originalExitCode = process.exitCode;

async function git(root: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd: root });
}

async function changedRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-adversarial-extension-"));
  tempRepos.push(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "review@example.test");
  await git(root, "config", "user.name", "Review Test");
  await writeFile(path.join(root, "example.ts"), "export const value = 1;\n");
  await git(root, "add", "example.ts");
  await git(root, "commit", "-qm", "base");
  await writeFile(path.join(root, "example.ts"), "export const value = 2;\n");
  return root;
}

function resolvedLocalPreflight(
  root: string,
  summary: string,
  selection: "explicit" | "inferred" | "interactive" = "inferred",
): ResolvedReviewPreflight {
  return {
    target: { mode: "local" },
    audit: {
      selection,
      fetchStatus: "succeeded",
      branch: "feature/review",
      remote: "origin",
      fetchedRemotes: ["origin"],
      defaultBranchRef: "origin/main",
      ahead: 2,
      behind: 0,
    },
    summary,
    inputSize: { bytes: 1024, lines: 20 },
    largeInput: false,
    guard: {
      root,
      headSha: "a".repeat(40),
      statusSha256: "b".repeat(64),
      branch: "feature/review",
      remote: "origin",
      defaultBranchRef: "origin/main",
      defaultBranchSha: "c".repeat(40),
      unmerged: false,
      targetSha256: "d".repeat(64),
      inputSha256: "e".repeat(64),
      targetRefs: [],
    },
  };
}

function context(cwd = process.cwd()) {
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const widgets: Array<{
    key: string;
    content: unknown;
    options?: { placement?: "aboveEditor" | "belowEditor" };
  }> = [];
  const tui = { requestRender: vi.fn() };
  const theme = {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
  };
  const ui = {
    notify: (message: string, type?: string) => notifications.push({ message, type }),
    onTerminalInput: vi.fn(() => () => {}),
    setStatus: (key: string, value: string | undefined) => statuses.push({ key, value }),
    setWidget: (
      key: string,
      content: unknown,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ) => widgets.push({ key, content, ...(options ? { options } : {}) }),
    custom: async (factory: any) => new Promise((resolve) => {
      let component: { dispose?: () => void } | undefined;
      component = factory(tui, theme, {}, (value: unknown) => {
        component?.dispose?.();
        resolve(value);
      });
    }),
  };
  const ctx = {
    cwd,
    mode: "tui",
    model: model("main-provider", "main-model"),
    thinkingLevel: "medium",
    scopedModels: [
      { model: model("provider-a", "model-a") },
      { model: model("provider-b", "model-b") },
    ],
    sessionManager: { getSessionId: () => "test-session" },
    ui,
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, statuses, widgets, tui, theme };
}

beforeAll(() => {
  initTheme("dark", false);
});

afterEach(async () => {
  freezeHooks.intercept = undefined;
  vi.useRealTimers();
  process.exitCode = originalExitCode;
  await Promise.all(workspaceHooks.created.splice(0).map((workspace) => workspace.cleanup()));
  await Promise.all(tempRepos.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("adversarial review extension", () => {
  it("registers only the slash command, transcript renderers, and shutdown lifecycle", () => {
    const fake = new FakePi();
    adversarialReviewExtension(fake.api());

    expect([...fake.commands.keys()]).toEqual([ADVERSARIAL_REVIEW_COMMAND]);
    expect(fake.registerTool).not.toHaveBeenCalled();
    expect(fake.registerMessageRenderer).toHaveBeenCalledTimes(2);
    expect(fake.registerMessageRenderer).toHaveBeenCalledWith(
      "adversarial-review-report",
      expect.any(Function),
    );
    expect(fake.registerMessageRenderer).toHaveBeenCalledWith(
      "adversarial-review-cancellation",
      expect.any(Function),
    );
    expect(fake.registerEntryRenderer).toHaveBeenCalledTimes(4);
    for (const type of [
      "adversarial-review-dispatch",
      "adversarial-review-result",
      "adversarial-review-cancellation",
      "adversarial-review-error",
    ]) {
      expect(fake.registerEntryRenderer).toHaveBeenCalledWith(type, expect.any(Function));
    }
    expect(fake.handlers.get("session_shutdown")).toHaveLength(1);
  });

  it("completes target preflight before runtime selection and persists its audit", async () => {
    const root = await changedRepo();
    const fake = new FakePi();
    const order: string[] = [];
    let nextAgent = 0;
    fake.eventResponder = (event, data) => {
      if (event !== "subagents:rpc:spawn") return;
      order.push("spawn");
      const agentId = `preflight-agent-${nextAgent++}`;
      fake.events.emit("subagents:completed", {
        id: agentId,
        correlationId: data.options.correlationId,
        status: "completed",
        result: JSON.stringify({ verdict: "approve", summary: "clean", findings: [] }),
      });
      fake.events.emit(`${event}:reply:${data.requestId}`, {
        success: true,
        data: { id: agentId },
      });
    };
    adversarialReviewExtension(fake.api(), {
      resolvePreflight: async ({ target }) => {
        order.push("preflight");
        return {
          target,
          audit: {
            selection: "inferred",
            fetchStatus: "succeeded",
            branch: "feature/preflight",
            remote: "origin",
            fetchedRemotes: ["origin"],
            defaultBranchRef: "origin/main",
            ahead: 2,
            behind: 1,
          },
          summary: "Adversarial review target: inferred feature branch.",
          inputSize: { bytes: 1024, lines: 20 },
          largeInput: false,
          guard: {
            root,
            headSha: "a".repeat(40),
            statusSha256: "b".repeat(64),
            branch: "feature/preflight",
            remote: "origin",
            defaultBranchRef: "origin/main",
            defaultBranchSha: "c".repeat(40),
            unmerged: false,
            targetSha256: "d".repeat(64),
            inputSha256: "e".repeat(64),
            targetRefs: [],
          },
        };
      },
      resolveRuntime: async ({ events }) => {
        order.push("runtime");
        return {
          runtime: new PiSubagentRpcV3Client(events),
          capabilities: { protocolVersion: 3, maxConcurrent: 2, backend: "external-v3" },
          dispose: async () => {},
        };
      },
    });
    const { ctx, notifications } = context(root);

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--local --reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );

    expect(order[0]).toBe("preflight");
    expect(order.indexOf("runtime")).toBeGreaterThan(order.indexOf("preflight"));
    expect(order.indexOf("spawn")).toBeGreaterThan(order.indexOf("runtime"));
    expect(notifications[0]).toEqual({
      message: "Adversarial review target: inferred feature branch.",
      type: "info",
    });
    expect(fake.entry("adversarial-review-result")?.data.target.preflight).toEqual({
      selection: "inferred",
      fetchStatus: "succeeded",
      branch: "feature/preflight",
      remote: "origin",
      fetchedRemotes: ["origin"],
      defaultBranchRef: "origin/main",
      ahead: 2,
      behind: 1,
    });
  });

  it("reruns target preflight when Git changes while the reviewer picker is open", async () => {
    const root = await changedRepo();
    const fake = new FakePi();
    let nextAgent = 0;
    fake.eventResponder = (event, data) => {
      if (event !== "subagents:rpc:spawn") return;
      const agentId = `guard-agent-${nextAgent++}`;
      fake.events.emit("subagents:completed", {
        id: agentId,
        correlationId: data.options.correlationId,
        status: "completed",
        result: JSON.stringify({ verdict: "approve", summary: "clean", findings: [] }),
        requestedModel: { provider: data.options.model.provider, modelId: data.options.model.id },
        requestedThinkingLevel: data.options.thinkingLevel,
        effectiveModel: { provider: data.options.model.provider, modelId: data.options.model.id },
        effectiveThinkingLevel: data.options.thinkingLevel,
      });
      fake.events.emit(`${event}:reply:${data.requestId}`, {
        success: true,
        data: { id: agentId },
      });
    };
    let preflightCount = 0;
    const resolvePreflight = vi.fn(async () => {
      preflightCount++;
      return resolvedLocalPreflight(
        root,
        `Adversarial review target: pass ${preflightCount}.`,
        preflightCount === 1 ? "inferred" : "interactive",
      );
    });
    const revalidatePreflight = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    adversarialReviewExtension(fake.api(), {
      resolvePreflight,
      revalidatePreflight,
      resolveRuntime: async ({ events }) => ({
        runtime: new PiSubagentRpcV3Client(events),
        capabilities: { protocolVersion: 3, maxConcurrent: 2, backend: "external-v3" },
        dispose: async () => {},
      }),
    });
    const { ctx, notifications, tui, theme } = context(root);
    (ctx.ui as any).custom = async (factory: any) => new Promise((resolve) => {
      let component: { handleInput(data: string): void; dispose?: () => void } | undefined;
      component = factory(tui, theme, {}, (value: unknown) => {
        component?.dispose?.();
        resolve(value);
      });
      const picker = component;
      if (!picker) throw new Error("Reviewer picker was not created.");
      picker.handleInput("\r");
      picker.handleInput("\x1b[B");
      picker.handleInput("\r");
      picker.handleInput("\x1b[B"); // Refute defaults to main session
      picker.handleInput("\x1b[B");
      picker.handleInput("\r");
    });

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler("", ctx);

    expect(resolvePreflight).toHaveBeenCalledTimes(2);
    expect(revalidatePreflight).toHaveBeenCalledTimes(2);
    expect(notifications).toContainEqual({
      message: "Adversarial review: Git changed while selecting models; running preflight again.",
      type: "warning",
    });
    expect(fake.entry("adversarial-review-result")?.data.target.preflight.selection).toBe("interactive");
    expect(fake.entry("adversarial-review-result")?.data.overall).toBe("candidate-approve");
  });

  it("cleans a frozen candidate and prevents runtime spawn when the guard changes during freeze", async () => {
    const root = await changedRepo();
    const fake = new FakePi();
    const resolveRuntime = vi.fn(async () => ({
      runtime: new PiSubagentRpcV3Client(fake.events),
      capabilities: { protocolVersion: 3 as const, maxConcurrent: 2, backend: "external-v3" as const },
      dispose: async () => {},
    }));
    const revalidatePreflight = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    adversarialReviewExtension(fake.api(), {
      resolvePreflight: async () => resolvedLocalPreflight(
        root,
        "Adversarial review target: guarded local.",
      ),
      revalidatePreflight,
      resolveRuntime,
    });
    const { ctx, notifications } = context(root);

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--local --reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );

    expect(revalidatePreflight).toHaveBeenCalledTimes(2);
    expect(resolveRuntime).toHaveBeenCalledTimes(1);
    expect(fake.emitted.some(({ event }) => event === "subagents:rpc:spawn")).toBe(false);
    expect(fake.entry("adversarial-review-error")).toMatchObject({
      data: {
        kind: "input",
        message: expect.stringContaining("Git state changed while freezing"),
      },
    });
    expect(notifications.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("Git state changed while freezing"),
    });
  });

  it("aborts an unfinished freeze, cleans it, and publishes a truthful cancellation audit", async () => {
    const root = await changedRepo();
    const fake = new FakePi();
    const resolveRuntime = vi.fn();
    let markFreezeStarted!: () => void;
    const freezeStarted = new Promise<void>((resolve) => { markFreezeStarted = resolve; });
    let temporaryWorkspace: string | undefined;
    freezeHooks.intercept = async ({ signal }): Promise<never> => {
      temporaryWorkspace = await mkdtemp(path.join(tmpdir(), "pi-adversarial-extension-freeze-"));
      await writeFile(path.join(temporaryWorkspace, "partial"), "partial workspace\n");
      markFreezeStarted();
      try {
        return await new Promise<never>((_resolve, reject) => {
          if (!signal) {
            reject(new Error("freeze did not receive the run signal"));
            return;
          }
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } finally {
        await rm(temporaryWorkspace, { recursive: true, force: true });
      }
    };
    adversarialReviewExtension(fake.api(), {
      resolvePreflight: async () => resolvedLocalPreflight(
        root,
        "Adversarial review target: cancellable local.",
      ),
      revalidatePreflight: async () => true,
      resolveRuntime,
    });
    const { ctx, notifications, tui, theme } = context(root);
    (ctx.ui as any).custom = async (factory: any) => new Promise((resolve) => {
      let component: { handleInput(data: string): void; dispose?: () => void } | undefined;
      component = factory(tui, theme, {}, (value: unknown) => {
        component?.dispose?.();
        resolve(value);
      });
      void freezeStarted.then(() => {
        component?.handleInput("\x1b");
        component?.handleInput("\x1b[B");
        component?.handleInput("\r");
      });
    });
    vi.mocked(persistStandaloneAudit).mockClear();

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--local --reviewer provider-a/model-a@high --reviewer provider-b/model-b@high " +
        "--refute --refuter provider-a/model-a@high",
      ctx,
    );

    expect(resolveRuntime).not.toHaveBeenCalled();
    expect(fake.emitted.some(({ event }) => event === "subagents:rpc:spawn")).toBe(false);
    expect(temporaryWorkspace).toBeDefined();
    await expect(access(temporaryWorkspace!)).rejects.toThrow();
    expect(fake.entries).toEqual([{
      customType: "adversarial-review-cancellation",
      data: expect.objectContaining({
        version: 1,
        status: "cancelled",
        phase: "freeze",
        target: {
          request: { mode: "local" },
          preflight: expect.objectContaining({ selection: "inferred", fetchStatus: "succeeded" }),
        },
        requestedRoutes: [
          expect.objectContaining({ key: "provider-a/model-a@high" }),
          expect.objectContaining({ key: "provider-b/model-b@high" }),
        ],
        refuteRequested: true,
        refuterRoute: expect.objectContaining({ key: "provider-a/model-a@high" }),
        gating: "weighted",
        startedAt: expect.any(String),
        cancelledAt: expect.any(String),
      }),
    }]);
    expect(fake.entries[0]?.data).not.toHaveProperty("inputSha256");
    expect(fake.entries[0]?.data).not.toHaveProperty("routeResults");
    expect(persistStandaloneAudit).toHaveBeenCalledWith(expect.objectContaining({
      kind: "cancellation",
      mode: "tui",
      payload: fake.entries[0]?.data,
    }));
    expect(notifications.at(-1)).toEqual({
      message: "Adversarial review: cancelled while freezing input; no reviewer was started.",
      type: "info",
    });
  });

  it.each([
    ["a concurrent non-abort input error", false, "Concurrent linked-worktree setup failed after run abort."],
    ["a workspace cleanup error", true, "input freeze failed and temporary review workspace cleanup also failed"],
  ])("publishes failure rather than freeze cancellation for %s", async (_label, cleanupFails, diagnostic) => {
    const root = await changedRepo();
    const fake = new FakePi();
    const resolveRuntime = vi.fn();
    let markFreezeStarted!: () => void;
    const freezeStarted = new Promise<void>((resolve) => { markFreezeStarted = resolve; });
    freezeHooks.intercept = async ({ signal }): Promise<never> => {
      markFreezeStarted();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      const freezeError = new ReviewInputError(
        "Concurrent linked-worktree setup failed after run abort.",
      );
      if (cleanupFails) {
        throw new ReviewInputCleanupError(
          signal?.reason,
          new Error("simulated temporary workspace cleanup failure"),
        );
      }
      throw freezeError;
    };
    adversarialReviewExtension(fake.api(), {
      resolvePreflight: async () => resolvedLocalPreflight(
        root,
        "Adversarial review target: error-after-abort local.",
      ),
      revalidatePreflight: async () => true,
      resolveRuntime,
    });
    const { ctx, notifications, tui, theme } = context(root);
    (ctx.ui as any).custom = async (factory: any) => new Promise((resolve) => {
      let component: { handleInput(data: string): void; dispose?: () => void } | undefined;
      component = factory(tui, theme, {}, (value: unknown) => {
        component?.dispose?.();
        resolve(value);
      });
      void freezeStarted.then(() => {
        component?.handleInput("\x1b");
        component?.handleInput("\x1b[B");
        component?.handleInput("\r");
      });
    });
    vi.mocked(persistStandaloneAudit).mockClear();

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--local --reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );

    expect(resolveRuntime).not.toHaveBeenCalled();
    expect(fake.emitted.some(({ event }) => event === "subagents:rpc:spawn")).toBe(false);
    // The failure is visible in the transcript, but it must not be mislabeled
    // as a user cancellation or trigger a standalone TUI audit file.
    expect(fake.entry("adversarial-review-error")).toMatchObject({
      data: { kind: "input", message: expect.stringContaining(diagnostic) },
    });
    expect(fake.entry("adversarial-review-cancellation")).toBeUndefined();
    expect(persistStandaloneAudit).not.toHaveBeenCalled();
    expect(notifications.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining(diagnostic),
    });
  });

  it("makes session shutdown wait for unfinished freeze cleanup", async () => {
    const root = await changedRepo();
    const fake = new FakePi();
    let markFreezeStarted!: () => void;
    const freezeStarted = new Promise<void>((resolve) => { markFreezeStarted = resolve; });
    let markAbortObserved!: () => void;
    const abortObserved = new Promise<void>((resolve) => { markAbortObserved = resolve; });
    let allowCleanup!: () => void;
    const cleanupAllowed = new Promise<void>((resolve) => { allowCleanup = resolve; });
    let temporaryWorkspace: string | undefined;
    freezeHooks.intercept = async ({ signal }): Promise<never> => {
      temporaryWorkspace = await mkdtemp(path.join(tmpdir(), "pi-adversarial-shutdown-freeze-"));
      markFreezeStarted();
      let reason: unknown;
      try {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        reason = signal?.reason;
        markAbortObserved();
        await cleanupAllowed;
      } finally {
        await rm(temporaryWorkspace, { recursive: true, force: true });
      }
      throw reason;
    };
    adversarialReviewExtension(fake.api(), {
      resolvePreflight: async () => resolvedLocalPreflight(
        root,
        "Adversarial review target: shutdown local.",
      ),
      revalidatePreflight: async () => true,
      resolveRuntime: vi.fn(),
    });
    const { ctx } = context(root);
    const command = fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--local --reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );
    await freezeStarted;
    let shutdownResolved = false;
    const shutdown = Promise.all(
      (fake.handlers.get("session_shutdown") ?? []).map((handler) => handler()),
    ).then(() => { shutdownResolved = true; });
    await abortObserved;

    expect(shutdownResolved).toBe(false);
    await expect(access(temporaryWorkspace!)).resolves.toBeUndefined();
    allowCleanup();
    await Promise.all([command, shutdown]);

    expect(shutdownResolved).toBe(true);
    await expect(access(temporaryWorkspace!)).rejects.toThrow();
    expect(fake.emitted.some(({ event }) => event === "subagents:rpc:spawn")).toBe(false);
    expect(fake.entries[0]).toMatchObject({
      customType: "adversarial-review-cancellation",
      data: { status: "cancelled", phase: "freeze" },
    });
  });

  it("makes session shutdown wait for an in-flight Git preflight cancellation", async () => {
    const fake = new FakePi();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const resolveRuntime = vi.fn();
    adversarialReviewExtension(fake.api(), {
      resolvePreflight: async ({ signal }) => {
        markStarted();
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return undefined;
      },
      resolveRuntime,
    });
    const { ctx, statuses, notifications } = context();

    const command = fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--local --reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );
    await started;
    const shutdown = Promise.all(
      (fake.handlers.get("session_shutdown") ?? []).map((handler) => handler()),
    );
    await Promise.all([command, shutdown]);

    expect(resolveRuntime).not.toHaveBeenCalled();
    expect(fake.emitted.some(({ event }) => event === "subagents:rpc:spawn")).toBe(false);
    expect(statuses).toEqual([]);
    expect(notifications).toEqual([]);
  });

  it("lets TUI Escape cancel an in-flight Git preflight before runtime selection", async () => {
    const fake = new FakePi();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const resolveRuntime = vi.fn();
    adversarialReviewExtension(fake.api(), {
      resolvePreflight: async ({ signal }) => {
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return undefined;
      },
      resolveRuntime,
    });
    const { ctx, notifications, statuses } = context();
    let terminalInput: ((data: string) => void) | undefined;
    (ctx.ui.onTerminalInput as any).mockImplementation((handler: (data: string) => void) => {
      terminalInput = handler;
      return () => { terminalInput = undefined; };
    });

    const command = fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--local --reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );
    await started;
    terminalInput?.("\x1b");
    await command;

    expect(resolveRuntime).not.toHaveBeenCalled();
    expect(fake.emitted.some(({ event }) => event === "subagents:rpc:spawn")).toBe(false);
    expect(statuses).toEqual([]);
    expect(notifications.at(-1)).toEqual({
      message: "Adversarial review: Git preflight cancelled.",
      type: "info",
    });
  });

  it("rejects bare --range headlessly before reviewer or runtime validation", async () => {
    const fake = new FakePi();
    const resolvePreflight = vi.fn();
    const resolveRuntime = vi.fn();
    adversarialReviewExtension(fake.api(), { resolvePreflight, resolveRuntime });
    const { ctx } = context();
    Object.assign(ctx, { mode: "json" });

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler("--range", ctx);

    expect(resolvePreflight).not.toHaveBeenCalled();
    expect(resolveRuntime).not.toHaveBeenCalled();
    expect(fake.entries).toContainEqual({
      customType: "adversarial-review-error",
      data: expect.objectContaining({
        kind: "command",
        mode: "json",
        message: expect.stringContaining("Interactive --range requires TUI mode"),
      }),
    });
  });

  it("passes bare --range to TUI preflight without treating it as local", async () => {
    const fake = new FakePi();
    const resolvePreflight = vi.fn(async () => undefined);
    adversarialReviewExtension(fake.api(), { resolvePreflight });
    const { ctx } = context();

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--range --reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );

    expect(resolvePreflight).toHaveBeenCalledWith(expect.objectContaining({
      target: { mode: "local" },
      targetExplicit: true,
      interactiveRange: true,
    }));
    expect(fake.emitted.some(({ event }) => event === "subagents:rpc:spawn")).toBe(false);
  });

  it("publishes a stable headless input error when automatic fetch preflight fails", async () => {
    const fake = new FakePi();
    const resolveRuntime = vi.fn();
    adversarialReviewExtension(fake.api(), {
      resolvePreflight: async () => {
        throw new ReviewInputError(
          "Automatic Git fetch failed for remote \"origin\". Pass --local for an explicit offline review.",
        );
      },
      resolveRuntime,
    });
    const { ctx } = context();
    Object.assign(ctx, { mode: "json" });

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );

    expect(resolveRuntime).not.toHaveBeenCalled();
    expect(fake.entries).toContainEqual({
      customType: "adversarial-review-error",
      data: expect.objectContaining({
        kind: "input",
        mode: "json",
        message: expect.stringContaining("Automatic Git fetch failed"),
      }),
    });
    expect(process.exitCode).toBe(1);
  });

  it("validates explicit routes without doing runtime work", () => {
    const { ctx } = context();
    const preflight = preflightReviewCommand(
      "--reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );

    expect(preflight.routes.map((route) => route.key)).toEqual([
      "provider-a/model-a@high",
      "provider-b/model-b@high",
    ]);
    expect(preflight.command.target).toEqual({ mode: "local" });
    expect(preflightReviewCommand(
      "--range --reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    ).command).toMatchObject({
      interactiveRange: true,
      targetExplicit: true,
    });
  });

  it("runs the local two-route command and triggers one audited adjudication follow-up", async () => {
    const root = await changedRepo();
    const fake = new FakePi();
    const frozenPaths: string[] = [];
    let nextAgent = 0;
    fake.eventResponder = (event, data) => {
      if (event === "subagents:rpc:ping") {
        fake.events.emit(`${event}:reply:${data.requestId}`, {
          success: true,
          data: { version: 3, maxConcurrent: 2 },
        });
        return;
      }
      if (event === "subagents:rpc:spawn") {
        const agentId = `agent-${nextAgent++}`;
        const inputPath = /^Frozen input file: (.+)$/mu.exec(data.prompt)?.[1];
        if (inputPath) frozenPaths.push(inputPath);
        fake.events.emit("subagents:completed", {
          id: agentId,
          correlationId: data.options.correlationId,
          status: "completed",
          result: JSON.stringify({ verdict: "approve", summary: "clean", findings: [] }),
          requestedModel: {
            provider: data.options.model.provider,
            modelId: data.options.model.id,
          },
          requestedThinkingLevel: data.options.thinkingLevel,
          effectiveModel: {
            provider: data.options.model.provider,
            modelId: data.options.model.id,
          },
          effectiveThinkingLevel: data.options.thinkingLevel,
        });
        fake.events.emit(`${event}:reply:${data.requestId}`, {
          success: true,
          data: { id: agentId },
        });
      }
    };
    adversarialReviewExtension(fake.api());
    const { ctx, notifications, widgets } = context(root);
    // The main model explicitly rejects the current thinking level. A review
    // that did not request Refute must still reach the reviewer fleet.
    (ctx.model as any).thinkingLevelMap = { medium: null };

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );

    expect(fake.entries).toHaveLength(2);
    expect(fake.entries[0]).toMatchObject({
      customType: "adversarial-review-dispatch",
      data: { status: "dispatched", requestedRoutes: expect.any(Array) },
    });
    expect(fake.entry("adversarial-review-result")).toMatchObject({
      customType: "adversarial-review-result",
      data: {
        overall: "candidate-approve",
        successfulReviewerCount: 2,
        refuteRequested: false,
      },
    });
    expect(fake.sentMessages).toHaveLength(1);
    expect(fake.sentMessages[0]).toMatchObject({
      message: {
        customType: "adversarial-review-report",
        details: { overall: "candidate-approve", successfulReviewerCount: 2 },
      },
      options: { deliverAs: "followUp", triggerTurn: true },
    });
    expect(fake.sentMessages[0].message.content).toContain("final adjudicator");
    expect(JSON.stringify(fake.sentMessages[0].message.details)).not.toContain('"model":');
    expect(notifications.at(-1)).toEqual({
      message: "Adversarial review: candidate-approve (2/2 valid). Refute disabled.",
      type: "info",
    });
    expect(widgets[0]).toMatchObject({
      key: "adversarial-review-run",
      content: expect.any(Function),
      options: { placement: "aboveEditor" },
    });
    expect(widgets.at(-1)).toEqual({
      key: "adversarial-review-run",
      content: undefined,
    });
    expect(frozenPaths).toHaveLength(2);
    for (const inputPath of frozenPaths) await expect(access(inputPath)).rejects.toThrow();
  });

  it("runs through an embedded backend without requiring a Subagents ping handler", async () => {
    const root = await changedRepo();
    const fake = new FakePi();
    const dispose = vi.fn(async () => {});
    let nextAgent = 0;
    fake.eventResponder = (event, data) => {
      if (event !== "subagents:rpc:spawn") return;
      const agentId = `embedded-${nextAgent++}`;
      fake.events.emit("subagents:completed", {
        id: agentId,
        correlationId: data.options.correlationId,
        status: "completed",
        result: JSON.stringify({ verdict: "approve", summary: "clean", findings: [] }),
        requestedModel: {
          provider: data.options.model.provider,
          modelId: data.options.model.id,
        },
        requestedThinkingLevel: data.options.thinkingLevel,
        effectiveModel: {
          provider: data.options.model.provider,
          modelId: data.options.model.id,
        },
        effectiveThinkingLevel: data.options.thinkingLevel,
      });
      fake.events.emit(`${event}:reply:${data.requestId}`, {
        success: true,
        data: { id: agentId },
      });
    };
    adversarialReviewExtension(fake.api(), {
      resolveRuntime: async ({ events }) => ({
        runtime: new PiSubagentRpcV3Client(events),
        capabilities: {
          protocolVersion: 3,
          maxConcurrent: 2,
          backend: "embedded",
          fallbackReason: "unavailable",
        },
        dispose,
      }),
    });
    const { ctx } = context(root);

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );

    expect(fake.emitted.some(({ event }) => event === "subagents:rpc:ping")).toBe(false);
    expect(fake.entry("adversarial-review-result")).toMatchObject({
      customType: "adversarial-review-result",
      data: {
        overall: "candidate-approve",
        runtime: {
          backend: "embedded",
          fallbackReason: "unavailable",
        },
      },
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("bounds shutdown on embedded dispose timeout and retains frozen input", async () => {
    const root = await changedRepo();
    const fake = new FakePi();
    const startedHandlers = new Set<(event: any) => void>();
    const terminalHandlers = new Set<(event: any) => void>();
    let spawnCount = 0;
    let frozenInputPath: string | undefined;
    let markAllSpawned!: () => void;
    const allSpawned = new Promise<void>((resolve) => { markAllSpawned = resolve; });
    const never = new Promise<void>(() => {});
    const core = {
      getCapabilities: () => ({ maxConcurrent: 2 }),
      spawn: (input: any) => {
        const id = `embedded-stuck-${spawnCount++}`;
        frozenInputPath ??= /^Frozen input file: (.+)$/mu.exec(input.prompt)?.[1];
        queueMicrotask(() => {
          for (const handler of startedHandlers) {
            handler({ id, correlationId: input.correlationId });
          }
        });
        if (spawnCount === 2) markAllSpawned();
        return { id };
      },
      abort: vi.fn(() => never),
      dispose: vi.fn(() => never),
      onStarted: (handler: (event: any) => void) => {
        startedHandlers.add(handler);
        return () => startedHandlers.delete(handler);
      },
      onTerminal: (handler: (event: any) => void) => {
        terminalHandlers.add(handler);
        return () => terminalHandlers.delete(handler);
      },
    };
    const embedded = new EmbeddedReviewRuntime(core as any, { terminalDeadlineMs: 10 });
    adversarialReviewExtension(fake.api(), {
      resolveRuntime: async () => ({
        runtime: embedded,
        capabilities: { protocolVersion: 3, maxConcurrent: 2, backend: "embedded" },
        dispose: () => embedded.dispose(),
      }),
    });
    const { ctx } = context(root);
    const command = fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--local --reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );
    await allSpawned;

    const shutdown = Promise.all(
      (fake.handlers.get("session_shutdown") ?? []).map((handler) => handler()),
    );
    await expect(Promise.race([
      shutdown.then(() => "shutdown"),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 1_000)),
    ])).resolves.toBe("shutdown");
    await command;

    expect(core.abort).toHaveBeenCalledTimes(2);
    expect(core.dispose).toHaveBeenCalledOnce();
    expect(frozenInputPath).toBeDefined();
    await expect(access(frozenInputPath!)).resolves.toBeUndefined();
    tempRepos.push(path.dirname(frozenInputPath!));
  });

  it("retains the frozen input while malformed spawn replies have late-start reapers", async () => {
    const root = await changedRepo();
    const fake = new FakePi();
    let frozenInputPath: string | undefined;
    const correlations: string[] = [];
    fake.eventResponder = (event, data) => {
      if (event === "subagents:rpc:ping") {
        fake.events.emit(`${event}:reply:${data.requestId}`, {
          success: true,
          data: { version: 3, maxConcurrent: 2 },
        });
        return;
      }
      if (event !== "subagents:rpc:spawn") return;
      frozenInputPath ??= /^Frozen input file: (.+)$/mu.exec(data.prompt)?.[1];
      correlations.push(data.options.correlationId);
      // The runtime may still have accepted the spawn; only its reply identity
      // was lost, so cleanup must preserve input until the reaper closes.
      fake.events.emit(`${event}:reply:${data.requestId}`, {
        success: true,
        data: {},
      });
    };
    adversarialReviewExtension(fake.api());
    const { ctx, notifications } = context(root);

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );

    expect(correlations).toHaveLength(2);
    expect(frozenInputPath).toBeDefined();
    await expect(access(frozenInputPath!)).resolves.toBeUndefined();
    tempRepos.push(path.dirname(frozenInputPath!));
    expect(notifications.at(-1)).toMatchObject({
      type: "warning",
      message: expect.stringContaining("Frozen input and any detached review worktree were retained for safety"),
    });

    for (const [index, correlationId] of correlations.entries()) {
      fake.events.emit("subagents:failed", {
        id: `malformed-terminal-${index}`,
        correlationId,
        status: "failed",
      });
    }
  });

  it("runs one fresh refuter per blocking cluster and keeps refuted findings blocking", async () => {
    const root = await changedRepo();
    const fake = new FakePi();
    let nextAgent = 0;
    fake.eventResponder = (event, data) => {
      if (event === "subagents:rpc:ping") {
        fake.events.emit(`${event}:reply:${data.requestId}`, {
          success: true,
          data: { version: 3, maxConcurrent: 2 },
        });
        return;
      }
      if (event !== "subagents:rpc:spawn") return;
      const agentId = `agent-${nextAgent++}`;
      const refuter = data.options.inlineAgentConfig.name === "adversarial-refuter";
      const result = refuter
        ? {
            refuted: true,
            reason: "The caller awaits persistence before returning.",
            evidence: ["src/caller.ts:8 awaits save"],
          }
        : {
            verdict: "needs-attention",
            summary: "material durability regression",
            findings: [{
              file: "example.ts",
              lineStart: 1,
              lineEnd: 1,
              severity: "high",
              category: "data-integrity",
              confidence: 0.9,
              invariant: "Writes are durable before success",
              issue: "The save returns success before data persistence completes",
              evidence: "example.ts:1 returns the new value",
              recommendation: "Await persistence before returning success",
            }],
          };
      fake.events.emit("subagents:completed", {
        id: agentId,
        correlationId: data.options.correlationId,
        status: "completed",
        result: JSON.stringify(result),
        requestedModel: { provider: data.options.model.provider, modelId: data.options.model.id },
        requestedThinkingLevel: data.options.thinkingLevel,
        effectiveModel: { provider: data.options.model.provider, modelId: data.options.model.id },
        effectiveThinkingLevel: data.options.thinkingLevel,
      });
      fake.events.emit(`${event}:reply:${data.requestId}`, {
        success: true,
        data: { id: agentId },
      });
    };
    adversarialReviewExtension(fake.api());
    const { ctx, notifications, statuses } = context(root);
    (ctx.scopedModels as any).push({ model: model("provider-c", "refuter") });

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high " +
        "--reviewer provider-b/model-b@high " +
        "--allow-large --refute --refuter provider-c/refuter@high",
      ctx,
    );

    const spawns = fake.emitted.filter((item) => item.event === "subagents:rpc:spawn");
    expect(spawns).toHaveLength(3);
    expect(spawns.slice(0, 2).every(({ data }) => data.options.maxTurns === 40)).toBe(true);
    expect(spawns.at(-1)?.data).toMatchObject({
      type: "adversarial-refuter",
      options: {
        maxTurns: 20,
        correlationId: expect.stringContaining(":refuter:0"),
        inlineAgentConfig: { builtinToolNames: ["read", "grep", "find", "ls"] },
      },
    });
    expect(fake.entry("adversarial-review-result")?.data).toMatchObject({
      overall: "needs-adjudication",
      runtime: {
        maxTurns: 40,
        routeTimeoutMs: 1_200_000,
        overallTimeoutMs: 1_800_000,
      },
      blocking: [{ issue: "The save returns success before data persistence completes" }],
      refuteRequested: true,
      refuteRuntime: {
        maxTurns: 20,
        routeTimeoutMs: 600_000,
        overallTimeoutMs: 1_800_000,
      },
      refuteResults: [{ findingIndex: 0, status: "completed", report: { refuted: true } }],
      contested: [{ findingIndex: 0, reason: "The caller awaits persistence before returning." }],
    });
    expect(fake.entry("adversarial-review-result")?.data.blocking).toHaveLength(1);
    expect(notifications.some(({ message }) => message.includes("Adversarial refute armed:"))).toBe(false);
    expect(notifications.some(({ message }) => message.includes("Refute 1/1 valid; 1 contested."))).toBe(true);
    expect(statuses).toEqual([]);
    expect(fake.sentMessages[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(JSON.stringify(fake.sentMessages[0]?.message.details)).not.toContain('"model":');
  });

  it("uses the current main session as default refuter but spends no route on a clean review", async () => {
    const root = await changedRepo();
    const fake = new FakePi();
    let nextAgent = 0;
    fake.eventResponder = (event, data) => {
      if (event === "subagents:rpc:ping") {
        fake.events.emit(`${event}:reply:${data.requestId}`, {
          success: true,
          data: { version: 3, maxConcurrent: 2 },
        });
        return;
      }
      if (event !== "subagents:rpc:spawn") return;
      const agentId = `clean-agent-${nextAgent++}`;
      fake.events.emit("subagents:completed", {
        id: agentId,
        correlationId: data.options.correlationId,
        status: "completed",
        result: JSON.stringify({ verdict: "approve", summary: "clean", findings: [] }),
        requestedModel: { provider: data.options.model.provider, modelId: data.options.model.id },
        requestedThinkingLevel: data.options.thinkingLevel,
        effectiveModel: { provider: data.options.model.provider, modelId: data.options.model.id },
        effectiveThinkingLevel: data.options.thinkingLevel,
      });
      fake.events.emit(`${event}:reply:${data.requestId}`, { success: true, data: { id: agentId } });
    };
    adversarialReviewExtension(fake.api());
    const { ctx, notifications, statuses } = context(root);

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high --reviewer provider-b/model-b@high --refute",
      ctx,
    );

    const spawns = fake.emitted.filter((item) => item.event === "subagents:rpc:spawn");
    expect(spawns).toHaveLength(2);
    expect(spawns.every((item) => item.data.type === "adversarial-reviewer")).toBe(true);
    expect(fake.emitted.filter((item) => item.event === "subagents:rpc:ping")).toHaveLength(1);
    expect(fake.entry("adversarial-review-result")?.data).toMatchObject({
      overall: "candidate-approve",
      blocking: [],
      refuteRequested: true,
      refuterRoute: {
        key: "main-provider/main-model@medium",
        thinkingSource: "main-session",
      },
      refuteResults: [],
      contested: [],
    });
    expect(notifications.some(({ message }) => message.includes("Adversarial refute armed:"))).toBe(false);
    expect(notifications.some(({ message }) => message.includes("Refute skipped: no blocking findings."))).toBe(true);
    expect(statuses).toEqual([]);
  });

  it("spawns a blocking refuter with the current main-session route", async () => {
    const root = await changedRepo();
    const fake = new FakePi();
    let nextAgent = 0;
    fake.eventResponder = (event, data) => {
      if (event === "subagents:rpc:ping") {
        fake.events.emit(`${event}:reply:${data.requestId}`, {
          success: true,
          data: { version: 3, maxConcurrent: 2 },
        });
        return;
      }
      if (event !== "subagents:rpc:spawn") return;
      const agentId = `main-refuter-agent-${nextAgent++}`;
      const refuter = data.options.inlineAgentConfig.name === "adversarial-refuter";
      const result = refuter
        ? { refuted: false, reason: "The durability finding holds.", evidence: [] }
        : {
            verdict: "needs-attention",
            summary: "durability regression",
            findings: [{
              file: "example.ts",
              lineStart: 1,
              lineEnd: 1,
              severity: "high",
              category: "data-integrity",
              confidence: 0.9,
              invariant: "Writes are durable before success",
              issue: "The save returns success before persistence completes",
              evidence: "example.ts:1 returns before persistence",
              recommendation: "Await persistence",
            }],
          };
      fake.events.emit("subagents:completed", {
        id: agentId,
        correlationId: data.options.correlationId,
        status: "completed",
        result: JSON.stringify(result),
        requestedModel: { provider: data.options.model.provider, modelId: data.options.model.id },
        requestedThinkingLevel: data.options.thinkingLevel,
        effectiveModel: { provider: data.options.model.provider, modelId: data.options.model.id },
        effectiveThinkingLevel: data.options.thinkingLevel,
      });
      fake.events.emit(`${event}:reply:${data.requestId}`, { success: true, data: { id: agentId } });
    };
    adversarialReviewExtension(fake.api());
    const { ctx } = context(root);

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high --reviewer provider-b/model-b@high --refute",
      ctx,
    );

    const spawns = fake.emitted.filter((item) => item.event === "subagents:rpc:spawn");
    expect(spawns).toHaveLength(3);
    expect(spawns.at(-1)?.data).toMatchObject({
      type: "adversarial-refuter",
      options: {
        model: { provider: "main-provider", id: "main-model" },
        thinkingLevel: "medium",
      },
    });
    expect(fake.entry("adversarial-review-result")?.data).toMatchObject({
      refuterRoute: {
        key: "main-provider/main-model@medium",
        thinkingSource: "main-session",
      },
      refuteResults: [{ status: "completed", report: { refuted: false } }],
      contested: [],
    });
  });

  it("runs routes selected by the TUI picker without requiring reviewer flags", async () => {
    const root = await changedRepo();
    const fake = new FakePi();
    let nextAgent = 0;
    fake.eventResponder = (event, data) => {
      if (event === "subagents:rpc:ping") {
        fake.events.emit(`${event}:reply:${data.requestId}`, {
          success: true,
          data: { version: 3, maxConcurrent: 1 },
        });
        return;
      }
      if (event === "subagents:rpc:spawn") {
        const agentId = `picked-agent-${nextAgent++}`;
        fake.events.emit("subagents:completed", {
          id: agentId,
          correlationId: data.options.correlationId,
          status: "completed",
          result: JSON.stringify({ verdict: "approve", summary: "clean", findings: [] }),
          requestedModel: { provider: data.options.model.provider, modelId: data.options.model.id },
          requestedThinkingLevel: data.options.thinkingLevel,
          effectiveModel: { provider: data.options.model.provider, modelId: data.options.model.id },
          effectiveThinkingLevel: data.options.thinkingLevel,
        });
        fake.events.emit(`${event}:reply:${data.requestId}`, {
          success: true,
          data: { id: agentId },
        });
      }
    };
    adversarialReviewExtension(fake.api());
    const { ctx, tui, theme } = context(root);
    let customCall = 0;
    (ctx.ui as any).custom = async (factory: any) => new Promise((resolve) => {
      let component: { handleInput(data: string): void; dispose?: () => void } | undefined;
      component = factory(tui, theme, {}, (value: unknown) => {
        component?.dispose?.();
        resolve(value);
      });
      if (customCall++ === 0) {
        const picker = component;
        if (!picker) throw new Error("Picker component was not created.");
        picker.handleInput("\r"); // first model -> medium
        picker.handleInput("\x1b[B");
        picker.handleInput("\r"); // second model -> medium
        picker.handleInput("\x1b[B"); // Refute defaults to main session
        picker.handleInput("\x1b[B");
        picker.handleInput("\r"); // Run
      }
    });

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler("", ctx);

    const spawns = fake.emitted.filter((item) => item.event === "subagents:rpc:spawn");
    expect(spawns).toHaveLength(2);
    expect(spawns.map((item) => item.data.options.thinkingLevel)).toEqual(["medium", "medium"]);
    expect(fake.entry("adversarial-review-result")?.data).toMatchObject({
      overall: "candidate-approve",
      successfulReviewerCount: 2,
      runtime: { maxConcurrent: 1, waves: 2 },
      refuteRequested: true,
      refuterRoute: {
        key: "main-provider/main-model@medium",
        thinkingSource: "main-session",
      },
      refuteResults: [],
    });
    expect(fake.emitted.filter((item) => item.event === "subagents:rpc:ping")).toHaveLength(1);
  });

  it("does not start or publish when shutdown races immediately after picker confirmation", async () => {
    const fake = new FakePi();
    fake.eventResponder = (event, data) => {
      if (event === "subagents:rpc:ping") {
        fake.events.emit(`${event}:reply:${data.requestId}`, {
          success: true,
          data: { version: 3, maxConcurrent: 2 },
        });
      }
    };
    adversarialReviewExtension(fake.api());
    const { ctx, notifications, statuses, tui, theme } = context();
    (ctx.ui as any).custom = async (factory: any) => new Promise((resolve) => {
      const component = factory(tui, theme, {}, (value: unknown) => {
        resolve(value);
        for (const shutdown of fake.handlers.get("session_shutdown") ?? []) void shutdown();
      });
      component.handleInput("\r");
      component.handleInput("\x1b[B");
      component.handleInput("\r");
      component.handleInput("\x1b[B"); // Refute defaults to main session
      component.handleInput("\x1b[B");
      component.handleInput("\r");
    });

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler("", ctx);

    expect(fake.entries).toEqual([]);
    expect(fake.sentMessages).toEqual([]);
    expect(fake.emitted.some((item) => item.event === "subagents:rpc:spawn")).toBe(false);
    expect(statuses).toEqual([]);
    expect(notifications).toEqual([
      { message: "Adversarial review target: test-local.", type: "info" },
    ]);
  });

  it("keeps the frozen input and shutdown pending until stopped agents reach terminal", async () => {
    const root = await changedRepo();
    const fake = new FakePi();
    const agents = new Map<string, { correlationId: string; stopRequest?: any }>();
    const frozenPaths: string[] = [];
    let nextAgent = 0;
    fake.eventResponder = (event, data) => {
      if (event === "subagents:rpc:ping") {
        fake.events.emit(`${event}:reply:${data.requestId}`, {
          success: true,
          data: { version: 3, maxConcurrent: 2 },
        });
        return;
      }
      if (event === "subagents:rpc:spawn") {
        const agentId = `shutdown-agent-${nextAgent++}`;
        const inputPath = /^Frozen input file: (.+)$/mu.exec(data.prompt)?.[1];
        if (inputPath) frozenPaths.push(inputPath);
        agents.set(agentId, { correlationId: data.options.correlationId });
        fake.events.emit("subagents:started", {
          id: agentId,
          correlationId: data.options.correlationId,
          requestedModel: { provider: data.options.model.provider, modelId: data.options.model.id },
          requestedThinkingLevel: data.options.thinkingLevel,
        });
        fake.events.emit(`${event}:reply:${data.requestId}`, {
          success: true,
          data: { id: agentId },
        });
        return;
      }
      if (event === "subagents:rpc:stop") {
        const agent = agents.get(data.agentId);
        if (agent) agent.stopRequest = data;
      }
    };
    adversarialReviewExtension(fake.api());
    const { ctx } = context(root);

    const command = fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );
    await vi.waitFor(() => expect(frozenPaths).toHaveLength(2));

    let shutdownResolved = false;
    const shutdown = Promise.all(
      (fake.handlers.get("session_shutdown") ?? []).map((handler) => handler()),
    ).then(() => { shutdownResolved = true; });
    await vi.waitFor(() => {
      expect([...agents.values()].every((agent) => agent.stopRequest)).toBe(true);
    });

    expect(shutdownResolved).toBe(false);
    await expect(access(frozenPaths[0]!)).resolves.toBeUndefined();

    for (const [agentId, agent] of agents) {
      fake.events.emit("subagents:completed", {
        id: agentId,
        correlationId: agent.correlationId,
        status: "stopped",
        result: "",
      });
      fake.events.emit(`subagents:rpc:stop:reply:${agent.stopRequest.requestId}`, {
        success: true,
      });
    }

    await Promise.all([shutdown, command]);
    expect(shutdownResolved).toBe(true);
    for (const inputPath of frozenPaths) await expect(access(inputPath)).rejects.toThrow();
    expect(fake.entries).toEqual([
      expect.objectContaining({
        customType: "adversarial-review-dispatch",
        data: expect.objectContaining({ status: "dispatched" }),
      }),
    ]);
    expect(fake.sentMessages).toEqual([]);
  });

  it("turns confirmed loader cancellation after freezing into an audited run", async () => {
    const root = await changedRepo();
    const before = (await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    })).stdout;
    const fake = new FakePi();
    let markRuntimePing!: () => void;
    const runtimePing = new Promise<void>((resolve) => { markRuntimePing = resolve; });
    fake.eventResponder = (event, data) => {
      if (event === "subagents:rpc:ping") {
        markRuntimePing();
        fake.events.emit(`${event}:reply:${data.requestId}`, {
          success: true,
          data: { version: 3, maxConcurrent: 2 },
        });
      }
    };
    adversarialReviewExtension(fake.api());
    const { ctx, notifications, statuses, tui, theme } = context(root);
    (ctx.ui as any).custom = async (factory: any) => new Promise((resolve) => {
      let component: { handleInput(data: string): void; dispose?: () => void } | undefined;
      component = factory(tui, theme, {}, (value: unknown) => {
        component?.dispose?.();
        resolve(value);
      });
      void runtimePing.then(() => {
        component?.handleInput("\x1b");
        component?.handleInput("\x1b[B");
        component?.handleInput("\r");
      });
    });

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );

    expect(fake.entry("adversarial-review-result")?.data).toMatchObject({
      overall: "cancelled",
      routeResults: [
        { status: "cancelled" },
        { status: "cancelled" },
      ],
    });
    expect(fake.emitted.some((item) => item.event === "subagents:rpc:spawn")).toBe(false);
    expect(fake.sentMessages).toEqual([]);
    expect(notifications.at(-1)).toMatchObject({
      type: "warning",
      message: expect.stringContaining("Adversarial review: cancelled"),
    });
    expect(statuses).toEqual([]);
    expect((await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    })).stdout).toBe(before);
  });

  it("keeps the cancelled audit when Escape interrupts the final Git guard", async () => {
    const root = await changedRepo();
    const fake = new FakePi();
    fake.eventResponder = (event, data) => {
      if (event === "subagents:rpc:ping") {
        fake.events.emit(`${event}:reply:${data.requestId}`, {
          success: true,
          data: { version: 3, maxConcurrent: 2 },
        });
      }
    };
    let markFinalGuard!: () => void;
    const finalGuardStarted = new Promise<void>((resolve) => { markFinalGuard = resolve; });
    let validationCount = 0;
    adversarialReviewExtension(fake.api(), {
      revalidatePreflight: async (_preflight, { signal } = {}) => {
        validationCount++;
        if (validationCount === 1) return true;
        markFinalGuard();
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return true;
      },
    });
    const { ctx, tui, theme } = context(root);
    (ctx.ui as any).custom = async (factory: any) => new Promise((resolve) => {
      let component: { handleInput(data: string): void; dispose?: () => void } | undefined;
      component = factory(tui, theme, {}, (value: unknown) => {
        component?.dispose?.();
        resolve(value);
      });
      void finalGuardStarted.then(() => {
        component?.handleInput("\x1b");
        component?.handleInput("\x1b[B");
        component?.handleInput("\r");
      });
    });

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );

    expect(validationCount).toBe(2);
    expect(fake.entry("adversarial-review-result")?.data).toMatchObject({
      overall: "cancelled",
      routeResults: [{ status: "cancelled" }, { status: "cancelled" }],
    });
    expect(fake.emitted.some((item) => item.event === "subagents:rpc:spawn")).toBe(false);
    expect(fake.sentMessages).toEqual([]);
  });

  it("marks the final report stale when the target drifts during reviewer execution", async () => {
    const root = await changedRepo();
    const fake = new FakePi();
    let nextAgent = 0;
    fake.eventResponder = (event, data) => {
      if (event === "subagents:rpc:ping") {
        fake.events.emit(`${event}:reply:${data.requestId}`, {
          success: true,
          data: { version: 3, maxConcurrent: 2 },
        });
        return;
      }
      if (event !== "subagents:rpc:spawn") return;
      const agentId = `stale-agent-${nextAgent++}`;
      const complete = () => {
        fake.events.emit("subagents:completed", {
          id: agentId,
          correlationId: data.options.correlationId,
          status: "completed",
          result: JSON.stringify({ verdict: "approve", summary: "clean", findings: [] }),
          requestedModel: { provider: data.options.model.provider, modelId: data.options.model.id },
          requestedThinkingLevel: data.options.thinkingLevel,
          effectiveModel: { provider: data.options.model.provider, modelId: data.options.model.id },
          effectiveThinkingLevel: data.options.thinkingLevel,
        });
        fake.events.emit(`${event}:reply:${data.requestId}`, { success: true, data: { id: agentId } });
      };
      if (nextAgent === 2) void appendFile(path.join(root, "example.ts"), "// drift\n").then(complete);
      else complete();
    };
    adversarialReviewExtension(fake.api());
    const { ctx } = context(root);

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );

    expect(fake.entry("adversarial-review-result")?.data).toMatchObject({
      overall: "stale",
      stale: true,
      successfulReviewerCount: 2,
    });
    expect(fake.sentMessages[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("preserves provider-error and invalid-JSON routes in a failed e2e report", async () => {
    const root = await changedRepo();
    const before = (await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    })).stdout;
    const fake = new FakePi();
    let spawnIndex = 0;
    fake.eventResponder = (event, data) => {
      if (event === "subagents:rpc:ping") {
        fake.events.emit(`${event}:reply:${data.requestId}`, {
          success: true,
          data: { version: 3, maxConcurrent: 2 },
        });
        return;
      }
      if (event !== "subagents:rpc:spawn") return;
      if (spawnIndex++ === 0) {
        fake.events.emit(`${event}:reply:${data.requestId}`, {
          success: false,
          error: "provider unavailable",
        });
        return;
      }
      const agentId = "invalid-agent";
      fake.events.emit("subagents:completed", {
        id: agentId,
        correlationId: data.options.correlationId,
        status: "completed",
        result: "not-json",
        requestedModel: { provider: data.options.model.provider, modelId: data.options.model.id },
        requestedThinkingLevel: data.options.thinkingLevel,
        effectiveModel: { provider: data.options.model.provider, modelId: data.options.model.id },
        effectiveThinkingLevel: data.options.thinkingLevel,
      });
      fake.events.emit(`${event}:reply:${data.requestId}`, { success: true, data: { id: agentId } });
    };
    adversarialReviewExtension(fake.api());
    const { ctx } = context(root);
    Object.assign(ctx, { mode: "json" });

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );

    expect(fake.entry("adversarial-review-result")?.data).toMatchObject({
      overall: "failed",
      successfulReviewerCount: 0,
      routeResults: [
        { status: "errored", error: expect.stringContaining("provider unavailable") },
        { status: "invalid-output", rawOutput: "not-json" },
      ],
    });
    expect((await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    })).stdout).toBe(before);
  });

  it("times out running reviewers, stops both, and publishes every route", async () => {
    const root = await changedRepo();
    const before = (await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    })).stdout;
    const fake = new FakePi();
    let spawnCount = 0;
    let resolveAllSpawned!: () => void;
    const allSpawned = new Promise<void>((resolve) => { resolveAllSpawned = resolve; });
    fake.eventResponder = (event, data) => {
      if (event === "subagents:rpc:ping") {
        fake.events.emit(`${event}:reply:${data.requestId}`, {
          success: true,
          data: { version: 3, maxConcurrent: 2 },
        });
        return;
      }
      if (event === "subagents:rpc:spawn") {
        const agentId = `timeout-${data.options.correlationId.split(":").at(-1)}`;
        spawnCount++;
        fake.events.emit("subagents:started", {
          id: agentId,
          correlationId: data.options.correlationId,
        });
        fake.events.emit(`${event}:reply:${data.requestId}`, { success: true, data: { id: agentId } });
        if (spawnCount === 2) resolveAllSpawned();
        return;
      }
      if (event === "subagents:rpc:stop") {
        fake.events.emit("subagents:completed", { id: data.agentId, status: "stopped" });
        fake.events.emit(`${event}:reply:${data.requestId}`, { success: true });
      }
    };
    adversarialReviewExtension(fake.api());
    const { ctx } = context(root);
    Object.assign(ctx, { mode: "json" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });

    const command = fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );
    await allSpawned;
    expect(fake.emitted.filter((item) => item.event === "subagents:rpc:spawn")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await command;

    expect(fake.entry("adversarial-review-result")?.data).toMatchObject({
      overall: "failed",
      routeResults: [{ status: "timed-out" }, { status: "timed-out" }],
    });
    expect(fake.emitted.filter((item) => item.event === "subagents:rpc:stop")).toHaveLength(2);
    expect((await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    })).stdout).toBe(before);
  });

  it("fails oversized input before runtime work and leaves Git status unchanged", async () => {
    const root = await changedRepo();
    await appendFile(path.join(root, "example.ts"), "x".repeat(1100 * 1024));
    const before = (await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    })).stdout;
    const fake = new FakePi();
    adversarialReviewExtension(fake.api());
    const { ctx, notifications } = context(root);

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--allow-large --reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );

    expect(notifications.at(-1)).toMatchObject({ type: "error" });
    expect(notifications.at(-1)?.message).toContain("Frozen review input exceeds the 1048576-byte limit");
    expect(fake.emitted).toEqual([]);
    expect(fake.entry("adversarial-review-error")).toMatchObject({
      data: { kind: "input", message: expect.stringContaining("Frozen review input exceeds") },
    });
    expect((await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    })).stdout).toBe(before);
  });

  it("requires explicit reviewer routes outside TUI mode", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = new FakePi();
    adversarialReviewExtension(fake.api());
    const { ctx, notifications } = context();
    Object.assign(ctx, { mode: "json" });

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler("", ctx);

    expect(notifications[0]).toMatchObject({ type: "error" });
    expect(notifications[0].message).toContain("Outside TUI, pass at least two --reviewer");
    expect(fake.emitted).toHaveLength(0);
    expect(fake.entries[0]).toMatchObject({
      customType: "adversarial-review-error",
      data: { kind: "command", mode: "json" },
    });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Outside TUI"));
    expect(process.exitCode).toBe(1);
    stderr.mockRestore();
  });

  it("requires an explicit refuter outside TUI mode", async () => {
    const fake = new FakePi();
    adversarialReviewExtension(fake.api());
    const { ctx, notifications } = context();
    Object.assign(ctx, { mode: "json" });

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high --reviewer provider-b/model-b@high --refute",
      ctx,
    );

    expect(notifications[0]).toMatchObject({ type: "error" });
    expect(notifications[0].message).toContain("Outside TUI, pass --refuter");
    expect(fake.emitted).toHaveLength(0);
  });

  it("fails before runtime work when reviewer selection is invalid", async () => {
    const fake = new FakePi();
    adversarialReviewExtension(fake.api());
    const { ctx, notifications } = context();

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high",
      ctx,
    );

    expect(notifications[0]).toMatchObject({ type: "error" });
    expect(notifications[0].message).toContain("at least 2 distinct reviewer models");
  });
});
