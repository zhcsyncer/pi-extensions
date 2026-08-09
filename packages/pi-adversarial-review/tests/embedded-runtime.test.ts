import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createEmbeddedReviewRuntime,
  EmbeddedReviewRuntime,
} from "../src/runtime/embedded-runtime.ts";
import type { SpawnReviewAgentInput } from "../src/runtime/types.ts";

function model(): Model<any> {
  return { provider: "provider", id: "model", reasoning: true } as Model<any>;
}

function spawnInput(role: "reviewer" | "refuter" = "reviewer"): SpawnReviewAgentInput {
  return {
    role,
    prompt: "Inspect frozen input.",
    systemPrompt: `${role} system prompt`,
    cwd: "/frozen",
    model: model(),
    thinking: "high",
    maxTurns: 25,
    correlationId: `run:${role}:0`,
    description: `Run ${role}`,
  };
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

describe("EmbeddedReviewRuntime", () => {
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
    await expect(runtime.spawn(spawnInput("refuter"))).resolves.toEqual({
      agentId: "embedded-agent",
    });

    expect(core.spawn).toHaveBeenCalledWith(expect.objectContaining({
      type: "adversarial-refuter",
      correlationId: "run:refuter:0",
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
        persistSession: false,
      },
    }));

    await runtime.stop("embedded-agent");
    expect(core.abort).toHaveBeenCalledWith("embedded-agent");
    await runtime.dispose();
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
      requestedThinking: "off",
      effectiveThinking: "off",
    }));
  });
});
