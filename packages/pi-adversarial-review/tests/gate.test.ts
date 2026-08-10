import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  buildMergedReviewReport,
  findingConsensusThreshold,
  minSuccessfulReviewerCount,
} from "../src/convergence/gate.ts";
import type { Finding, ReviewerRoute, ReviewerRouteResult } from "../src/types.ts";

function route(ordinal: number): ReviewerRoute {
  return {
    key: `p${ordinal}/m${ordinal}@high`,
    provider: `p${ordinal}`,
    modelId: `m${ordinal}`,
    model: { provider: `p${ordinal}`, id: `m${ordinal}`, reasoning: true } as Model<any>,
    thinking: "high",
    thinkingSource: "user",
    ordinal,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/example.ts",
    lineStart: 10,
    lineEnd: 10,
    severity: "medium",
    category: "correctness",
    confidence: 0.7,
    invariant: "Requests return persisted state",
    issue: "The response can expose state before persistence",
    evidence: "src/example.ts:10 returns before await",
    recommendation: "Await persistence before returning",
    ...overrides,
  };
}

function completed(ordinal: number, findings: Finding[] = []): ReviewerRouteResult {
  return {
    route: route(ordinal),
    status: "completed",
    report: {
      verdict: findings.length ? "needs-attention" : "approve",
      summary: "review",
      findings,
    },
  };
}

function failed(ordinal: number): ReviewerRouteResult {
  return { route: route(ordinal), status: "errored", error: "provider failed" };
}

function build(options: {
  requested: number;
  results: ReviewerRouteResult[];
  gating?: "weighted" | "strict";
  stale?: boolean;
  cancelled?: boolean;
  refuteRequested?: boolean;
  refuterRoute?: ReviewerRoute;
}) {
  return buildMergedReviewReport({
    runId: "run",
    target: {
      mode: "local",
      description: "local",
      root: "/repo",
      headSha: "head",
      statusSha256: "status",
      targetSha256: "target",
      changedFiles: ["src/example.ts"],
    },
    charterSource: "builtin",
    charterSha256: "charter",
    requestedRoutes: Array.from({ length: options.requested }, (_, index) => route(index)),
    routeResults: options.results,
    runtimeCapabilities: { protocolVersion: 3, maxConcurrent: 2, backend: "external-v3" },
    maxTurns: 25,
    refuteRequested: options.refuteRequested ?? false,
    refuterRoute: options.refuterRoute,
    gating: options.gating ?? "weighted",
    stale: options.stale ?? false,
    cancelled: options.cancelled ?? false,
    limitedContext: [],
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: new Date("2026-01-01T00:01:00.000Z"),
  });
}

describe("gating thresholds", () => {
  it("uses the requested fleet for the health gate", () => {
    expect([2, 3, 4, 6, 8].map((count) => minSuccessfulReviewerCount(count)))
      .toEqual([2, 2, 2, 3, 4]);
  });

  it("uses only successful reviewers for finding consensus", () => {
    expect([2, 3, 4, 5, 6, 7, 8].map((count) => findingConsensusThreshold(count)))
      .toEqual([2, 2, 2, 3, 3, 4, 4]);
  });
});

describe("buildMergedReviewReport", () => {
  it("blocks a consensus finding in weighted mode", () => {
    const report = build({ requested: 2, results: [completed(0, [finding()]), completed(1, [finding()])] });
    expect(report).toMatchObject({
      overall: "needs-adjudication",
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
    });
    expect(report.blocking).toHaveLength(1);
    expect(report.advisory).toHaveLength(0);
  });

  it("keeps a single high-confidence high finding blocking", () => {
    const report = build({
      requested: 2,
      results: [completed(0, [finding({ severity: "high", confidence: 0.85 })]), completed(1)],
    });
    expect(report.overall).toBe("needs-adjudication");
    expect(report.blocking[0].votes).toBe(1);
  });

  it("leaves a single medium finding advisory and returns only candidate approval", () => {
    const report = build({ requested: 2, results: [completed(0, [finding()]), completed(1)] });
    expect(report.overall).toBe("candidate-approve");
    expect(report.blocking).toEqual([]);
    expect(report.advisory).toHaveLength(1);
  });

  it("requires adjudication when multiple reviewers raise distinct advisories", () => {
    const report = build({
      requested: 2,
      results: [
        completed(0, [finding({ file: "src/first.ts" })]),
        completed(1, [finding({ file: "src/second.ts", issue: "A separate medium-risk defect" })]),
      ],
    });
    expect(report.overall).toBe("needs-adjudication");
    expect(report.blocking).toEqual([]);
    expect(report.advisory).toHaveLength(2);
    expect(report.advisoryReviewerCount).toBe(2);
  });

  it("puts every valid cluster in blocking under strict mode", () => {
    const report = build({
      requested: 2,
      results: [completed(0, [finding()]), completed(1)],
      gating: "strict",
    });
    expect(report.overall).toBe("needs-adjudication");
    expect(report.blocking).toHaveLength(1);
    expect(report.advisory).toEqual([]);
  });

  it("is inconclusive below the health gate even when a blocking finding survives", () => {
    const report = build({
      requested: 4,
      results: [completed(0, [finding({ severity: "critical", confidence: 0.99 })]), failed(1), failed(2), failed(3)],
    });
    expect(report.overall).toBe("inconclusive");
    expect(report.blocking).toHaveLength(1);
    expect(report.successfulReviewerCount).toBe(1);
  });

  it("fails when no route produced a valid report", () => {
    const report = build({ requested: 2, results: [failed(0), failed(1)] });
    expect(report.overall).toBe("failed");
    expect(report.blocking).toEqual([]);
  });

  it("returns candidate-approve only after a healthy clean fleet", () => {
    const report = build({ requested: 2, results: [completed(0), completed(1)] });
    expect(report.overall).toBe("candidate-approve");
  });

  it("records refute intent only with one resolved route and starts with no refute result", () => {
    const refuterRoute = route(9);
    const report = build({
      requested: 2,
      results: [completed(0), completed(1)],
      refuteRequested: true,
      refuterRoute,
    });
    expect(report).toMatchObject({
      refuteRequested: true,
      refuterRoute,
      refuteResults: [],
      contested: [],
    });
    expect(() => build({
      requested: 2,
      results: [completed(0), completed(1)],
      refuteRequested: true,
    })).toThrow("require exactly one resolved refuter route");
  });

  it("lets stale and cancelled states override gating", () => {
    expect(build({ requested: 2, results: [completed(0), completed(1)], stale: true }).overall).toBe("stale");
    expect(build({
      requested: 2,
      results: [completed(0), completed(1)],
      stale: true,
      cancelled: true,
    }).overall).toBe("cancelled");
  });
});
