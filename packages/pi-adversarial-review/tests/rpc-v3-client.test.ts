import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { PiSubagentRpcV3Client, ReviewRuntimeError, type PiEventBus } from "../src/runtime/rpc-v3-client.ts";

class FakeBus implements PiEventBus {
  readonly handlers = new Map<string, Set<(data: any) => void>>();
  readonly emitted: Array<{ event: string; data: any }> = [];
  onEmit?: (event: string, data: any) => void;

  emit(event: string, data: any): void {
    this.emitted.push({ event, data });
    this.onEmit?.(event, data);
    for (const handler of this.handlers.get(event) ?? []) handler(data);
  }

  on(event: string, handler: (data: any) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  listenerCount(): number {
    return [...this.handlers.values()].reduce((total, handlers) => total + handlers.size, 0);
  }
}

function replyToRequests(bus: FakeBus, response: (event: string, data: any) => any): void {
  bus.onEmit = (event, data) => {
    if (!event.startsWith("subagents:rpc:") || event.includes(":reply:")) return;
    bus.emit(`${event}:reply:${data.requestId}`, response(event, data));
  };
}

function model(): Model<any> {
  return { provider: "provider-a", id: "model-a", reasoning: true } as Model<any>;
}

describe("PiSubagentRpcV3Client", () => {
  it("discovers protocol 3 and max concurrency", async () => {
    const bus = new FakeBus();
    replyToRequests(bus, () => ({ success: true, data: { version: 3, maxConcurrent: 4 } }));

    await expect(new PiSubagentRpcV3Client(bus).getCapabilities()).resolves.toEqual({
      protocolVersion: 3,
      maxConcurrent: 4,
    });
    expect(bus.listenerCount()).toBe(0);
  });

  it("rejects incompatible or malformed capability replies", async () => {
    const bus = new FakeBus();
    replyToRequests(bus, () => ({ success: true, data: { version: 2, maxConcurrent: 0 } }));
    await expect(new PiSubagentRpcV3Client(bus).getCapabilities()).rejects.toThrow(
      "Expected protocol 3",
    );
  });

  it("sends caller-owned inline reviewer config through the existing spawn RPC", async () => {
    const bus = new FakeBus();
    replyToRequests(bus, (event) => event.endsWith(":spawn")
      ? { success: true, data: { id: "agent-1" } }
      : { success: true });
    const runtime = new PiSubagentRpcV3Client(bus);

    await expect(runtime.spawn({
      prompt: "review input",
      systemPrompt: "review only",
      cwd: "/repo",
      model: model(),
      thinking: "high",
      maxTurns: 25,
      correlationId: "run:reviewer:0",
      description: "Review route",
    })).resolves.toEqual({ agentId: "agent-1" });

    const request = bus.emitted.find(({ event }) => event === "subagents:rpc:spawn")!.data;
    expect(request).toMatchObject({
      type: "adversarial-reviewer",
      prompt: "review input",
      options: {
        completionOwner: "caller",
        correlationId: "run:reviewer:0",
        isBackground: true,
        isolated: true,
        inheritContext: false,
        cwd: "/repo",
        thinkingLevel: "high",
        inlineAgentConfig: {
          name: "adversarial-reviewer",
          builtinToolNames: ["read", "grep", "find", "ls"],
          extensions: false,
          skills: false,
          promptMode: "replace",
          persistSession: false,
        },
      },
    });

    await runtime.stop("agent-1");
    expect(bus.emitted.find(({ event }) => event === "subagents:rpc:stop")!.data)
      .toMatchObject({ agentId: "agent-1" });
  });

  it("normalizes correlated started and terminal lifecycle events", () => {
    const bus = new FakeBus();
    const runtime = new PiSubagentRpcV3Client(bus);
    const started = vi.fn();
    const terminal = vi.fn();
    const offStarted = runtime.onStarted(started);
    const offTerminal = runtime.onTerminal(terminal);

    bus.emit("subagents:started", { id: "a1", correlationId: "r1" });
    bus.emit("subagents:completed", {
      id: "a1",
      correlationId: "r1",
      status: "completed",
      result: "{}",
      tokens: { input: 1, output: 2, total: 3 },
      requestedModel: { provider: "p", modelId: "m" },
      requestedThinkingLevel: "off",
      effectiveModel: { provider: "p", modelId: "m" },
      effectiveThinkingLevel: "off",
    });

    expect(started).toHaveBeenCalledWith({ agentId: "a1", correlationId: "r1" });
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "a1",
      correlationId: "r1",
      requestedThinking: "off",
      effectiveThinking: "off",
      usage: { input: 1, output: 2, total: 3 },
    }));
    offStarted();
    offTerminal();
    expect(bus.listenerCount()).toBe(0);
  });

  it("times out unanswered requests and removes reply listeners", async () => {
    const bus = new FakeBus();
    const runtime = new PiSubagentRpcV3Client(bus, 5);
    await expect(runtime.getCapabilities()).rejects.toBeInstanceOf(ReviewRuntimeError);
    expect(bus.listenerCount()).toBe(0);
  });
});
