import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { attachRefuteResults } from "../src/convergence/refute.ts";
import type {
  MergedFinding,
  MergedReviewReport,
  RefuteRouteResult,
  ReviewerRoute,
} from "../src/types.ts";

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
    lineStart: index + 1,
    lineEnd: index + 1,
    severity: "high",
    category: "correctness",
    confidence: 0.9,
    invariant: `Invariant ${index}`,
    issue: `Issue ${index}`,
    evidence: [`Evidence ${index}`],
    recommendation: `Repair ${index}`,
    reviewers: ["a/m@high", "b/m@high"],
    votes: 2,
    sourceFindingIndexes: [],
  };
}

function report(): MergedReviewReport {
  const blocking = [finding(0), finding(1)];
  return {
    version: 1,
    runId: "run",
    target: {
      mode: "local",
      description: "local",
      root: "/repo",
      headSha: "head",
      statusSha256: "status",
      targetSha256: "target",
      changedFiles: blocking.map((item) => item.file),
    },
    charterSource: "builtin",
    charterSha256: "charter",
    requestedRoutes: [route(), { ...route(), key: "provider/reviewer@high", ordinal: 1 }],
    routeResults: [],
    runtime: {
      protocolVersion: 3,
      maxConcurrent: 2,
      backend: "external-v3",
      waves: 1,
      maxTurns: 25,
      routeTimeoutMs: 600_000,
      overallTimeoutMs: 1_200_000,
    },
    successfulReviewerCount: 2,
    minSuccessfulReviewerCount: 2,
    consensusThreshold: 2,
    advisoryReviewerCount: 0,
    gating: "weighted",
    overall: "needs-adjudication",
    blocking,
    advisory: [],
    refuteRequested: true,
    refuterRoute: route(),
    refuteResults: [],
    contested: [],
    stale: false,
    limitedContext: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
  };
}

function completed(findingIndex: number, refuted: boolean): RefuteRouteResult {
  return {
    findingIndex,
    route: route(),
    status: "completed",
    report: {
      refuted,
      reason: refuted ? "Concrete contradiction" : "Finding survives",
      evidence: refuted ? [`src/file-${findingIndex}.ts:20`] : [],
    },
  };
}

describe("attachRefuteResults", () => {
  it("marks a concrete refutation contested without removing or downgrading blocking", () => {
    const original = report();
    const merged = attachRefuteResults({
      report: original,
      refuterRoute: route(),
      routeResults: [completed(1, false), completed(0, true)],
      capabilities: { protocolVersion: 3, maxConcurrent: 1, backend: "external-v3" },
      maxTurns: 12,
      stale: false,
      cancelled: false,
      completedAt: new Date("2026-01-01T00:02:00.000Z"),
    });

    expect(merged.blocking).toEqual(original.blocking);
    expect(merged.overall).toBe("needs-adjudication");
    expect(merged.refuteResults.map((result) => result.findingIndex)).toEqual([0, 1]);
    expect(merged.refuteRuntime).toEqual({
      protocolVersion: 3,
      maxConcurrent: 1,
      backend: "external-v3",
      waves: 2,
      maxTurns: 12,
      routeTimeoutMs: 300_000,
      overallTimeoutMs: 900_000,
    });
    expect(merged.contested).toEqual([{
      findingIndex: 0,
      finding: original.blocking[0],
      refuterRoute: route(),
      reason: "Concrete contradiction",
      evidence: ["src/file-0.ts:20"],
    }]);
    expect(merged.completedAt).toBe("2026-01-01T00:02:00.000Z");
  });

  it("keeps findings alive when refute fails, is invalid, or says refuted=false", () => {
    const original = report();
    const merged = attachRefuteResults({
      report: original,
      refuterRoute: route(),
      routeResults: [
        completed(0, false),
        { findingIndex: 1, route: route(), status: "invalid-output", error: "bad JSON" },
      ],
      capabilities: { protocolVersion: 3, maxConcurrent: 2, backend: "external-v3" },
      maxTurns: 12,
      stale: false,
      cancelled: false,
    });

    expect(merged.blocking).toHaveLength(2);
    expect(merged.contested).toEqual([]);
    expect(merged.overall).toBe("needs-adjudication");
  });

  it("lets stale and cancellation override status but never findings", () => {
    const stale = attachRefuteResults({
      report: report(),
      refuterRoute: route(),
      routeResults: [completed(0, true)],
      capabilities: { protocolVersion: 3, maxConcurrent: 2, backend: "external-v3" },
      maxTurns: 12,
      stale: true,
      cancelled: false,
    });
    expect(stale.overall).toBe("stale");
    expect(stale.blocking).toHaveLength(2);

    const cancelled = attachRefuteResults({
      report: report(),
      refuterRoute: route(),
      routeResults: [completed(0, true)],
      capabilities: { protocolVersion: 3, maxConcurrent: 2, backend: "external-v3" },
      maxTurns: 12,
      stale: true,
      cancelled: true,
    });
    expect(cancelled.overall).toBe("cancelled");
    expect(cancelled.blocking).toHaveLength(2);
  });

  it("rejects duplicate or out-of-range finding indexes", () => {
    expect(() => attachRefuteResults({
      report: report(),
      refuterRoute: route(),
      routeResults: [completed(0, true), completed(0, false)],
      capabilities: { protocolVersion: 3, maxConcurrent: 2, backend: "external-v3" },
      maxTurns: 12,
      stale: false,
      cancelled: false,
    })).toThrow("Duplicate refute finding index");
    expect(() => attachRefuteResults({
      report: report(),
      refuterRoute: route(),
      routeResults: [completed(2, true)],
      capabilities: { protocolVersion: 3, maxConcurrent: 2, backend: "external-v3" },
      maxTurns: 12,
      stale: false,
      cancelled: false,
    })).toThrow("Invalid refute finding index");
  });
});
