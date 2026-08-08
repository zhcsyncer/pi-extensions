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
import adversarialReviewExtension, {
  ADVERSARIAL_REVIEW_COMMAND,
  preflightReviewCommand,
} from "../src/index.ts";

class FakePi {
  readonly commands = new Map<string, any>();
  readonly handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  readonly eventHandlers = new Map<string, Set<(data: any) => void>>();
  readonly emitted: Array<{ event: string; data: any }> = [];
  readonly sentMessages: Array<{ message: any; options: any }> = [];
  readonly entries: Array<{ customType: string; data: any }> = [];
  readonly registerTool = vi.fn();
  readonly registerMessageRenderer = vi.fn();
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

  api(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}

function model(provider: string, id: string): Model<any> {
  return { provider, id, reasoning: true } as Model<any>;
}

const exec = promisify(execFile);
const tempRepos: string[] = [];

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

function context(cwd = process.cwd()) {
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const tui = { requestRender: vi.fn() };
  const theme = {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
  };
  const ui = {
    notify: (message: string, type?: string) => notifications.push({ message, type }),
    setStatus: (key: string, value: string | undefined) => statuses.push({ key, value }),
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
    scopedModels: [
      { model: model("provider-a", "model-a") },
      { model: model("provider-b", "model-b") },
    ],
    ui,
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, statuses, tui, theme };
}

beforeAll(() => {
  initTheme("dark", false);
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempRepos.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("adversarial review extension", () => {
  it("registers only the slash command, report renderer, and shutdown lifecycle", () => {
    const fake = new FakePi();
    adversarialReviewExtension(fake.api());

    expect([...fake.commands.keys()]).toEqual([ADVERSARIAL_REVIEW_COMMAND]);
    expect(fake.registerTool).not.toHaveBeenCalled();
    expect(fake.registerMessageRenderer).toHaveBeenCalledOnce();
    expect(fake.registerMessageRenderer).toHaveBeenCalledWith(
      "adversarial-review-report",
      expect.any(Function),
    );
    expect(fake.handlers.get("session_shutdown")).toHaveLength(1);
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
    const { ctx, notifications } = context(root);

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );

    expect(fake.entries).toHaveLength(1);
    expect(fake.entries[0]).toMatchObject({
      customType: "adversarial-review-report",
      data: { overall: "candidate-approve", successfulReviewerCount: 2 },
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
      message: "Adversarial review: candidate-approve (2/2 valid).",
      type: "info",
    });
    expect(frozenPaths).toHaveLength(2);
    for (const inputPath of frozenPaths) await expect(access(inputPath)).rejects.toThrow();
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
    const { ctx } = context(root);
    (ctx.scopedModels as any).push({ model: model("provider-c", "refuter") });

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high " +
        "--reviewer provider-b/model-b@high " +
        "--refute --refuter provider-c/refuter@high",
      ctx,
    );

    const spawns = fake.emitted.filter((item) => item.event === "subagents:rpc:spawn");
    expect(spawns).toHaveLength(3);
    expect(spawns.at(-1)?.data).toMatchObject({
      type: "adversarial-refuter",
      options: {
        maxTurns: 12,
        correlationId: expect.stringContaining(":refuter:0"),
        inlineAgentConfig: { builtinToolNames: ["read", "grep", "find", "ls"] },
      },
    });
    expect(fake.entries[0]?.data).toMatchObject({
      overall: "needs-adjudication",
      blocking: [{ issue: "The save returns success before data persistence completes" }],
      refuteRequested: true,
      refuteResults: [{ findingIndex: 0, status: "completed", report: { refuted: true } }],
      contested: [{ findingIndex: 0, reason: "The caller awaits persistence before returning." }],
    });
    expect(fake.entries[0]?.data.blocking).toHaveLength(1);
    expect(fake.sentMessages[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(JSON.stringify(fake.sentMessages[0]?.message.details)).not.toContain('"model":');
  });

  it("uses a second TUI picker for refuter but spends no refute route on a clean review", async () => {
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
        if (!picker) throw new Error("Refuter picker component was not created.");
        picker.handleInput("\r"); // first scoped model -> off
        picker.handleInput("\x1b[B");
        picker.handleInput("\x1b[B");
        picker.handleInput("\r"); // Use selected refuter
      }
    });

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high --reviewer provider-b/model-b@high --refute",
      ctx,
    );

    const spawns = fake.emitted.filter((item) => item.event === "subagents:rpc:spawn");
    expect(spawns).toHaveLength(2);
    expect(spawns.every((item) => item.data.type === "adversarial-reviewer")).toBe(true);
    expect(fake.emitted.filter((item) => item.event === "subagents:rpc:ping")).toHaveLength(1);
    expect(fake.entries[0]?.data).toMatchObject({
      overall: "candidate-approve",
      blocking: [],
      refuteRequested: true,
      refuterRoute: { key: "provider-a/model-a@off" },
      refuteResults: [],
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
        picker.handleInput("\r"); // first model -> off
        picker.handleInput("\x1b[B");
        picker.handleInput("\r"); // second model -> off
        picker.handleInput("\x1b[B");
        picker.handleInput("\r"); // Run
      }
    });

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler("", ctx);

    const spawns = fake.emitted.filter((item) => item.event === "subagents:rpc:spawn");
    expect(spawns).toHaveLength(2);
    expect(spawns.map((item) => item.data.options.thinkingLevel)).toEqual(["off", "off"]);
    expect(fake.entries[0]?.data).toMatchObject({
      overall: "candidate-approve",
      successfulReviewerCount: 2,
      runtime: { maxConcurrent: 1, waves: 2 },
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
      component.handleInput("\x1b[B");
      component.handleInput("\r");
    });

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler("", ctx);

    expect(fake.entries).toEqual([]);
    expect(fake.sentMessages).toEqual([]);
    expect(fake.emitted.some((item) => item.event === "subagents:rpc:spawn")).toBe(false);
    expect(statuses).toEqual([]);
    expect(notifications).toEqual([]);
  });

  it("turns loader Escape into a cancelled audited run and clears footer status", async () => {
    const root = await changedRepo();
    const before = (await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    })).stdout;
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
    const { ctx, statuses, tui, theme } = context(root);
    (ctx.ui as any).custom = async (factory: any) => new Promise((resolve) => {
      let component: { handleInput(data: string): void; dispose?: () => void } | undefined;
      component = factory(tui, theme, {}, (value: unknown) => {
        component?.dispose?.();
        resolve(value);
      });
      queueMicrotask(() => component?.handleInput("\x1b"));
    });

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );

    expect(fake.entries[0]?.data).toMatchObject({
      overall: "cancelled",
      routeResults: [
        { status: "cancelled" },
        { status: "cancelled" },
      ],
    });
    expect(fake.emitted.some((item) => item.event === "subagents:rpc:spawn")).toBe(false);
    expect(statuses.at(-1)).toEqual({ key: "adversarial-review", value: undefined });
    expect((await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    })).stdout).toBe(before);
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

    expect(fake.entries[0]?.data).toMatchObject({
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

    expect(fake.entries[0]?.data).toMatchObject({
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

    expect(fake.entries[0]?.data).toMatchObject({
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
    await appendFile(path.join(root, "example.ts"), "x".repeat(210 * 1024));
    const before = (await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    })).stdout;
    const fake = new FakePi();
    adversarialReviewExtension(fake.api());
    const { ctx, notifications } = context(root);

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );

    expect(notifications.at(-1)).toMatchObject({ type: "error" });
    expect(notifications.at(-1)?.message).toContain("Frozen review input is too large");
    expect(fake.emitted).toEqual([]);
    expect(fake.entries).toEqual([]);
    expect((await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    })).stdout).toBe(before);
  });

  it("requires explicit reviewer routes outside TUI mode", async () => {
    const fake = new FakePi();
    adversarialReviewExtension(fake.api());
    const { ctx, notifications } = context();
    Object.assign(ctx, { mode: "json" });

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler("", ctx);

    expect(notifications[0]).toMatchObject({ type: "error" });
    expect(notifications[0].message).toContain("Outside TUI, pass at least two --reviewer");
    expect(fake.emitted).toHaveLength(0);
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
