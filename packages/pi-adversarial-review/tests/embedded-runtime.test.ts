import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddedReviewRuntime,
  DEFAULT_EMBEDDED_TERMINAL_DEADLINE_MS,
  EmbeddedReviewRuntime,
} from "../src/runtime/embedded-runtime.ts";
import type { SpawnReviewAgentInput } from "../src/runtime/types.ts";

function model(): Model<any> {
  return { provider: "provider", id: "model", reasoning: true } as Model<any>;
}

function spawnInput(role: SpawnReviewAgentInput["role"] = "reviewer"): SpawnReviewAgentInput {
  return {
    role,
    prompt: "Inspect frozen input.",
    systemPrompt: `${role} system prompt`,
    cwd: "/frozen",
    model: model(),
    thinking: "high",
    maxTurns: 25,
    graceTurns: 15,
    correlationId: `run:${role}:0`,
    description: `Run ${role}`,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeCallerOwnedRuntime {
  readonly spawn = vi.fn(() => ({ id: "embedded-agent" }));
  readonly abort = vi.fn();
  readonly dispose = vi.fn(async () => {});
  readonly started = new Set<(event: any) => void>();
  readonly terminal = new Set<(event: any) => void>();

  getCapabilities() {
    return { maxConcurrent: 3 };
  }

  onStarted(handler: (event: any) => void) {
    this.started.add(handler);
    return () => this.started.delete(handler);
  }

  onTerminal(handler: (event: any) => void) {
    this.terminal.add(handler);
    return () => this.terminal.delete(handler);
  }

  emitStarted(event: any) {
    for (const handler of this.started) handler(event);
  }

  emitTerminal(event: any) {
    for (const handler of this.terminal) handler(event);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("EmbeddedReviewRuntime", () => {
  it("uses a 30-second Review-only terminal deadline by default", () => {
    expect(DEFAULT_EMBEDDED_TERMINAL_DEADLINE_MS).toBe(30_000);
  });
  it("loads the published runtime subpath without activating the Subagents extension", async () => {
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    } as any;
    const runtime = await createEmbeddedReviewRuntime({
      pi,
      ctx: { cwd: process.cwd() } as any,
      maxConcurrent: 1,
    });

    await expect(runtime.getCapabilities()).resolves.toEqual({
      protocolVersion: 3,
      maxConcurrent: 1,
      backend: "embedded",
    });
    expect(pi.registerTool).not.toHaveBeenCalled();
    expect(pi.registerCommand).not.toHaveBeenCalled();
    expect(pi.on).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it("maps reviewer and refuter requests onto the caller-owned runtime", async () => {
    const core = new FakeCallerOwnedRuntime();
    const runtime = new EmbeddedReviewRuntime(core as any);

    await expect(runtime.getCapabilities()).resolves.toEqual({
      protocolVersion: 3,
      maxConcurrent: 3,
      backend: "embedded",
    });
    const refuterInput = spawnInput("refuter");
    refuterInput.persistSession = true;
    await expect(runtime.spawn(refuterInput)).resolves.toEqual({
      agentId: "embedded-agent",
    });

    expect(core.spawn).toHaveBeenCalledWith(expect.objectContaining({
      type: "adversarial-refuter",
      correlationId: "run:refuter:0",
      maxTurns: 25,
      graceTurns: 15,
      isolated: true,
      inheritContext: false,
      inlineAgentConfig: {
        name: "adversarial-refuter",
        displayName: "Adversarial Refuter",
        description: "Independent adversarial finding refuter",
        builtinToolNames: ["read", "grep", "find", "ls"],
        extensions: false,
        skills: false,
        systemPrompt: "refuter system prompt",
        promptMode: "replace",
        persistSession: true,
      },
    }));

    await runtime.stop("embedded-agent");
    expect(core.abort).toHaveBeenCalledWith("embedded-agent");
    await runtime.dispose();
    expect(core.dispose).toHaveBeenCalledOnce();
  });

  it("gives format repair an independent tool-free inline role", async () => {
    const core = new FakeCallerOwnedRuntime();
    const runtime = new EmbeddedReviewRuntime(core as any);

    await runtime.spawn(spawnInput("format-repair"));

    expect(core.spawn).toHaveBeenCalledWith(expect.objectContaining({
      type: "adversarial-review-format-repair",
      inlineAgentConfig: expect.objectContaining({
        name: "adversarial-review-format-repair",
        displayName: "Review Format Repair",
        builtinToolNames: [],
        extensions: false,
        skills: false,
        persistSession: false,
      }),
    }));
    await runtime.dispose();
  });

  it("keeps timely stop terminal-truth behavior unchanged", async () => {
    const core = new FakeCallerOwnedRuntime();
    const terminal = deferred();
    core.abort.mockImplementation(() => terminal.promise);
    const runtime = new EmbeddedReviewRuntime(core as any, { terminalDeadlineMs: 50 });
    const { agentId } = await runtime.spawn(spawnInput());

    let resolved = false;
    const stopping = runtime.stop(agentId).then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(runtime.getUnsettledAgentIds()).toEqual([agentId]);
    terminal.resolve();

    await stopping;
    expect(resolved).toBe(true);
    expect(runtime.getUnsettledAgentIds()).toEqual([]);
    await runtime.dispose();
  });

  it("times out stop, tracks the id, and handles late settlement", async () => {
    vi.useFakeTimers();
    const core = new FakeCallerOwnedRuntime();
    const terminal = deferred();
    core.abort.mockImplementation(() => terminal.promise);
    const runtime = new EmbeddedReviewRuntime(core as any, { terminalDeadlineMs: 10 });
    const { agentId } = await runtime.spawn(spawnInput());
    const stopping = runtime.stop(agentId);
    const timedOut = expect(stopping).rejects.toThrow(
      "Embedded review agent embedded-agent did not reach terminal state within 10ms after stop",
    );
    await vi.advanceTimersByTimeAsync(10);

    await timedOut;
    expect(runtime.getUnsettledAgentIds()).toEqual([agentId]);
    terminal.reject(new Error("late caller-owned abort failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.getUnsettledAgentIds()).toEqual([agentId]);
    core.emitTerminal({ id: agentId });
    expect(runtime.getUnsettledAgentIds()).toEqual([]);
    await runtime.dispose();
  });

  it("bounds dispose without treating the deadline as terminal", async () => {
    vi.useFakeTimers();
    const core = new FakeCallerOwnedRuntime();
    const disposed = deferred();
    core.dispose.mockImplementation(() => disposed.promise);
    const runtime = new EmbeddedReviewRuntime(core as any, { terminalDeadlineMs: 10 });
    const { agentId } = await runtime.spawn(spawnInput());
    const disposing = runtime.dispose();
    const timedOut = expect(disposing).rejects.toThrow(
      `Embedded review runtime did not reach terminal state within 10ms during dispose; ` +
        `unsettled agents: ${agentId}`,
    );
    await vi.advanceTimersByTimeAsync(10);

    await timedOut;
    expect(runtime.getUnsettledAgentIds()).toEqual([agentId]);
    disposed.resolve();
    await Promise.resolve();
    await expect(runtime.dispose()).resolves.toBeUndefined();
    expect(runtime.getUnsettledAgentIds()).toEqual([]);
    expect(core.dispose).toHaveBeenCalledOnce();
  });

  it("normalizes embedded lifecycle events into the existing review contract", () => {
    const core = new FakeCallerOwnedRuntime();
    const runtime = new EmbeddedReviewRuntime(core as any);
    const started = vi.fn();
    const terminal = vi.fn();
    runtime.onStarted(started);
    runtime.onTerminal(terminal);

    core.emitStarted({
      id: "a1",
      correlationId: "run:reviewer:0",
      type: "adversarial-reviewer",
      description: "Review route",
    });
    core.emitTerminal({
      id: "a1",
      correlationId: "run:reviewer:0",
      type: "adversarial-reviewer",
      description: "Review route",
      status: "completed",
      result: "{}",
      durationMs: 12,
      tokens: { input: 1, output: 2, total: 3 },
      sessionFile: "/sessions/a1.jsonl",
      requestedModel: { provider: "provider", modelId: "model" },
      requestedThinkingLevel: "off",
      effectiveModel: { provider: "provider", modelId: "model" },
      effectiveThinkingLevel: "off",
    });

    expect(started).toHaveBeenCalledWith({
      agentId: "a1",
      correlationId: "run:reviewer:0",
    });
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "a1",
      correlationId: "run:reviewer:0",
      status: "completed",
      result: "{}",
      usage: { input: 1, output: 2, total: 3 },
      sessionFile: "/sessions/a1.jsonl",
      requestedThinking: "off",
      effectiveThinking: "off",
    }));
  });
});
