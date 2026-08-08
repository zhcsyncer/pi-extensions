import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { runRefuteFleet } from "../src/runtime/refute-orchestrator.ts";
import type {
  ReviewAgentStartedEvent,
  ReviewAgentTerminalEvent,
  ReviewSubagentRuntime,
  SpawnReviewAgentInput,
} from "../src/runtime/types.ts";
import type {
  FrozenReviewInput,
  MergedFinding,
  ReviewerRoute,
} from "../src/types.ts";

class FakeRuntime implements ReviewSubagentRuntime {
  readonly startedHandlers = new Set<(event: ReviewAgentStartedEvent) => void>();
  readonly terminalHandlers = new Set<(event: ReviewAgentTerminalEvent) => void>();
  readonly spawnInputs: SpawnReviewAgentInput[] = [];
  readonly stops: string[] = [];
  spawnImpl?: (input: SpawnReviewAgentInput, agentId: string) => Promise<{ agentId: string }>;

  async getCapabilities() {
    return { protocolVersion: 3 as const, maxConcurrent: 2 };
  }

  async spawn(input: SpawnReviewAgentInput): Promise<{ agentId: string }> {
    this.spawnInputs.push(input);
    const agentId = `refuter-${input.correlationId.split(":").at(-1)}`;
    return this.spawnImpl ? this.spawnImpl(input, agentId) : { agentId };
  }

  async stop(agentId: string): Promise<void> {
    this.stops.push(agentId);
  }

  onStarted(handler: (event: ReviewAgentStartedEvent) => void): () => void {
    this.startedHandlers.add(handler);
    return () => this.startedHandlers.delete(handler);
  }

  onTerminal(handler: (event: ReviewAgentTerminalEvent) => void): () => void {
    this.terminalHandlers.add(handler);
    return () => this.terminalHandlers.delete(handler);
  }

  emitStarted(event: ReviewAgentStartedEvent): void {
    for (const handler of this.startedHandlers) handler(event);
  }

  emitTerminal(event: ReviewAgentTerminalEvent): void {
    for (const handler of this.terminalHandlers) handler(event);
  }

  listenerCount(): number {
    return this.startedHandlers.size + this.terminalHandlers.size;
  }
}

function route(): ReviewerRoute {
  return {
    key: "provider/refuter@high",
    provider: "provider",
    modelId: "refuter",
    model: { provider: "provider", id: "refuter", reasoning: true } as Model<any>,
    thinking: "high",
    thinkingSource: "user",
    ordinal: 0,
  };
}

function finding(index: number): MergedFinding {
  return {
    file: `src/file-${index}.ts`,
    lineStart: 10 + index,
    lineEnd: 10 + index,
    severity: "high",
    category: "correctness",
    confidence: 0.9,
    invariant: `Invariant ${index}`,
    issue: `Material issue ${index}`,
    evidence: [`src/file-${index}.ts:${10 + index}`],
    recommendation: `Repair ${index}`,
    reviewers: ["a/m@high", "b/m@high"],
    votes: 2,
    sourceFindingIndexes: [],
  };
}

function frozen(): FrozenReviewInput {
  return {
    runId: "run-1",
    target: {
      mode: "local",
      description: "local",
      root: "/repo",
      headSha: "head",
      statusSha256: "status",
      targetSha256: "target",
      changedFiles: ["src/file-0.ts"],
    },
    reviewerCwd: "/repo",
    inputPath: "/tmp/input.md",
    charterSource: "builtin",
    charterSha256: "charter",
    limitedContext: [],
    recheck: vi.fn(async () => ({ stale: false, changed: [] })),
    cleanup: vi.fn(async () => {}),
  };
}

function terminalFor(
  input: SpawnReviewAgentInput,
  agentId: string,
  result: string,
  overrides: Partial<ReviewAgentTerminalEvent> = {},
): ReviewAgentTerminalEvent {
  return {
    agentId,
    correlationId: input.correlationId,
    status: "completed",
    result,
    requestedModel: { provider: input.model.provider, modelId: input.model.id },
    requestedThinking: input.thinking,
    effectiveModel: { provider: input.model.provider, modelId: input.model.id },
    effectiveThinking: input.thinking,
    ...overrides,
  };
}

describe("runRefuteFleet", () => {
  it("starts one fresh isolated refuter per blocking cluster and preserves index order", async () => {
    const runtime = new FakeRuntime();
    const progress: string[] = [];
    runtime.spawnImpl = async (input, agentId) => {
      const index = Number(input.correlationId.split(":").at(-1));
      runtime.emitTerminal(terminalFor(input, agentId, JSON.stringify({
        refuted: index === 0,
        reason: index === 0 ? "Concrete contradiction" : "Finding survives",
        evidence: index === 0 ? ["src/file-0.ts:30 proves ordering"] : [],
      })));
      return { agentId };
    };

    const result = await runRefuteFleet({
      runtime,
      refuterRoute: route(),
      blocking: [finding(0), finding(1)],
      frozenInput: frozen(),
      refuterSystemPrompt: "refute only",
      onProgress: (snapshot) => progress.push(
        `${snapshot.phase}:${snapshot.finished}/${snapshot.total}`,
      ),
    });

    expect(result.routeResults.map(({ findingIndex, status, report }) => ({
      findingIndex,
      status,
      refuted: report?.refuted,
    }))).toEqual([
      { findingIndex: 0, status: "completed", refuted: true },
      { findingIndex: 1, status: "completed", refuted: false },
    ]);
    expect(runtime.spawnInputs).toHaveLength(2);
    expect(runtime.spawnInputs.every((input) => input.role === "refuter" && input.maxTurns === 12)).toBe(true);
    expect(runtime.spawnInputs[0].prompt).toContain("Material issue 0");
    expect(runtime.spawnInputs[0].prompt).not.toContain("Material issue 1");
    expect(new Set(runtime.spawnInputs.map((input) => input.correlationId)).size).toBe(2);
    expect(progress[0]).toBe("refute:0/2");
    expect(progress.at(-1)).toBe("refute:2/2");
    expect(runtime.listenerCount()).toBe(0);
  });

  it("rejects a terminal event whose agent id disagrees with the spawn reply", async () => {
    const runtime = new FakeRuntime();
    runtime.spawnImpl = async (input, agentId) => {
      runtime.emitTerminal(terminalFor(input, "forged-refuter", JSON.stringify({
        refuted: true,
        reason: "forged contradiction",
        evidence: ["src/file-0.ts:99"],
      })));
      return { agentId };
    };

    const result = await runRefuteFleet({
      runtime,
      refuterRoute: route(),
      blocking: [finding(0)],
      frozenInput: frozen(),
      refuterSystemPrompt: "refute only",
    });

    expect(result.routeResults[0]).toMatchObject({
      status: "errored",
      agentId: "refuter-0",
      error: expect.stringContaining("does not match spawn reply agent"),
    });
    expect(runtime.stops.sort()).toEqual(["forged-refuter", "refuter-0"]);
  });

  it("preserves invalid output and route mismatch without weakening the finding", async () => {
    const runtime = new FakeRuntime();
    runtime.spawnImpl = async (input, agentId) => {
      const first = input.correlationId.endsWith(":0");
      runtime.emitTerminal(terminalFor(
        input,
        agentId,
        first ? '{"refuted":true,"reason":"no evidence","evidence":[]}' : JSON.stringify({
          refuted: true,
          reason: "contradiction",
          evidence: ["src/file-1.ts:22"],
        }),
        first ? {} : { effectiveModel: { provider: "wrong", modelId: "route" } },
      ));
      return { agentId };
    };

    const result = await runRefuteFleet({
      runtime,
      refuterRoute: route(),
      blocking: [finding(0), finding(1)],
      frozenInput: frozen(),
      refuterSystemPrompt: "refute only",
    });

    expect(result.routeResults[0]).toMatchObject({
      status: "invalid-output",
      error: expect.stringContaining("requires concrete evidence"),
    });
    expect(result.routeResults[1]).toMatchObject({
      status: "errored",
      error: expect.stringContaining("effective route does not match"),
    });
  });

  it("preserves refuter spawn/provider failure as an errored attempt", async () => {
    const runtime = new FakeRuntime();
    runtime.spawnImpl = async (input, agentId) => {
      runtime.emitStarted({ agentId, correlationId: input.correlationId });
      throw new Error("refuter provider unavailable");
    };

    const result = await runRefuteFleet({
      runtime,
      refuterRoute: route(),
      blocking: [finding(0)],
      frozenInput: frozen(),
      refuterSystemPrompt: "refute only",
    });

    expect(result.routeResults[0]).toMatchObject({
      status: "errored",
      error: "Spawn failed: refuter provider unavailable",
    });
    expect(runtime.stops).toEqual(["refuter-0"]);
  });

  it("times out a refuter, stops it, and ignores a late refuted=true terminal", async () => {
    const runtime = new FakeRuntime();
    runtime.spawnImpl = async (input, agentId) => {
      runtime.emitStarted({ agentId, correlationId: input.correlationId });
      return { agentId };
    };

    const result = await runRefuteFleet({
      runtime,
      refuterRoute: route(),
      blocking: [finding(0)],
      frozenInput: frozen(),
      refuterSystemPrompt: "refute only",
      routeTimeoutMs: 10,
      overallTimeoutMs: 100,
    });

    expect(result.routeResults[0].status).toBe("timed-out");
    expect(runtime.stops).toEqual(["refuter-0"]);
    runtime.emitTerminal(terminalFor(
      runtime.spawnInputs[0],
      "refuter-0",
      JSON.stringify({ refuted: true, reason: "late", evidence: ["late:1"] }),
    ));
    expect(result.routeResults[0].status).toBe("timed-out");
    expect(result.routeResults[0].report).toBeUndefined();
  });

  it("cancels active and queued refuters through the shared signal and stops each once", async () => {
    const runtime = new FakeRuntime();
    const controller = new AbortController();
    runtime.spawnImpl = async (input, agentId) => {
      if (input.correlationId.endsWith(":0")) {
        runtime.emitStarted({ agentId, correlationId: input.correlationId });
      }
      if (runtime.spawnInputs.length === 2) queueMicrotask(() => controller.abort());
      return { agentId };
    };

    const result = await runRefuteFleet({
      runtime,
      refuterRoute: route(),
      blocking: [finding(0), finding(1)],
      frozenInput: frozen(),
      refuterSystemPrompt: "refute only",
      signal: controller.signal,
      overallTimeoutMs: 100,
    });

    expect(result.routeResults.map(({ status }) => status)).toEqual(["cancelled", "cancelled"]);
    expect(runtime.stops.sort()).toEqual(["refuter-0", "refuter-1"]);
    expect(runtime.listenerCount()).toBe(0);
  });
});
