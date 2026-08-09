import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import type { Model } from "@earendil-works/pi-ai";
import { runAgent } from "../src/agent-runner.js";
import { pruneWorktrees } from "../src/worktree.js";
import { CallerOwnedAgentRuntime } from "../src/runtime.js";

const inlineAgentConfig = {
  name: "reviewer",
  description: "Runtime-only reviewer",
  builtinToolNames: ["read", "grep", "find", "ls"],
  extensions: false as const,
  skills: false as const,
  systemPrompt: "Review only.",
  promptMode: "replace" as const,
  persistSession: false,
};

function model(): Model<any> {
  return { provider: "provider", id: "model", reasoning: true } as Model<any>;
}

function spawnInput(correlationId = "run:reviewer:0") {
  return {
    type: "reviewer",
    prompt: "Review the frozen input.",
    description: "Review provider/model@high",
    model: model(),
    thinkingLevel: "high" as const,
    maxTurns: 25,
    cwd: process.cwd(),
    isolated: true,
    inheritContext: false,
    inlineAgentConfig,
    correlationId,
  };
}

const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CallerOwnedAgentRuntime", () => {
  it("reuses AgentManager lifecycle without registering extension surface", async () => {
    const session = {
      model: { provider: "provider", id: "model" },
      thinkingLevel: "high",
      dispose: vi.fn(),
    } as any;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      options.onAssistantUsage?.({ input: 3, output: 5, cacheWrite: 7 });
      return {
        responseText: "review-json",
        session,
        aborted: false,
        steered: false,
      };
    });
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendMessage: vi.fn(),
    } as any;
    const runtime = new CallerOwnedAgentRuntime({
      pi,
      ctx: { cwd: process.cwd() } as any,
      maxConcurrent: 2,
    });
    const started = vi.fn();
    const terminal = vi.fn();
    runtime.onStarted(started);
    runtime.onTerminal(terminal);

    const { id } = runtime.spawn(spawnInput());
    await flush();

    expect(runtime.getCapabilities()).toEqual({ maxConcurrent: 2 });
    expect(started).toHaveBeenCalledWith(expect.objectContaining({
      id,
      correlationId: "run:reviewer:0",
      requestedModel: { provider: "provider", modelId: "model" },
      requestedThinkingLevel: "high",
    }));
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({
      id,
      correlationId: "run:reviewer:0",
      status: "completed",
      result: "review-json",
      tokens: { input: 3, output: 5, total: 15 },
      effectiveModel: { provider: "provider", modelId: "model" },
      effectiveThinkingLevel: "high",
    }));
    expect(pi.registerTool).not.toHaveBeenCalled();
    expect(pi.registerCommand).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();

    await runtime.dispose();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(pruneWorktrees).not.toHaveBeenCalled();
  });

  it("emits a terminal event when queued caller-owned work is stopped", async () => {
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      const session = { dispose: vi.fn() } as any;
      options.onSessionCreated?.(session);
      await firstDone;
      return { responseText: "done", session, aborted: false, steered: false };
    });
    const runtime = new CallerOwnedAgentRuntime({
      pi: {} as any,
      ctx: { cwd: process.cwd() } as any,
      maxConcurrent: 1,
    });
    const terminal = vi.fn();
    runtime.onTerminal(terminal);

    runtime.spawn(spawnInput("run:first"));
    const queued = runtime.spawn(spawnInput("run:queued"));
    await runtime.abort(queued.id);

    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({
      id: queued.id,
      correlationId: "run:queued",
      status: "stopped",
    }));

    releaseFirst();
    await flush();
    await runtime.dispose();
  });

  it("does not resolve stop until the running execution emits terminal", async () => {
    let release!: () => void;
    const executionDone = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      const session = { dispose: vi.fn() } as any;
      options.onSessionCreated?.(session);
      await executionDone;
      return { responseText: "ignored", session, aborted: true, steered: false };
    });
    const runtime = new CallerOwnedAgentRuntime({
      pi: {} as any,
      ctx: { cwd: process.cwd() } as any,
      maxConcurrent: 1,
    });
    const terminal = vi.fn();
    runtime.onTerminal(terminal);
    const { id } = runtime.spawn(spawnInput("run:slow-stop"));

    let stopResolved = false;
    const stopping = runtime.abort(id).then(() => { stopResolved = true; });
    await flush();

    expect(stopResolved).toBe(false);
    expect(terminal).not.toHaveBeenCalled();

    release();
    await stopping;
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({
      id,
      correlationId: "run:slow-stop",
      status: "stopped",
    }));
    await runtime.dispose();
  });

  it("waits during dispose for a stopped record whose execution is still pending", async () => {
    let release!: () => void;
    const executionDone = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      const session = { dispose: vi.fn() } as any;
      options.onSessionCreated?.(session);
      await executionDone;
      return { responseText: "ignored", session, aborted: true, steered: false };
    });
    const runtime = new CallerOwnedAgentRuntime({
      pi: {} as any,
      ctx: { cwd: process.cwd() } as any,
      maxConcurrent: 1,
    });
    const { id } = runtime.spawn(spawnInput("run:dispose"));
    const stopping = runtime.abort(id);

    let disposeResolved = false;
    const disposing = runtime.dispose().then(() => { disposeResolved = true; });
    await flush();
    expect(disposeResolved).toBe(false);

    release();
    await Promise.all([stopping, disposing]);
    expect(disposeResolved).toBe(true);
  });
});
