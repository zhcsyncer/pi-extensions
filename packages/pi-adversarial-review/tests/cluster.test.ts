import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { clusterReviewFindings, jaccard, normalizedTokens } from "../src/convergence/cluster.ts";
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
    file: "src/state.ts",
    lineStart: 10,
    lineEnd: 12,
    severity: "medium",
    category: "data-integrity",
    confidence: 0.7,
    invariant: "Writes preserve durable user data",
    issue: "State is cleared before the durable write completes",
    evidence: "src/state.ts:10 clears the value before await",
    recommendation: "Clear state only after persistence succeeds",
    ...overrides,
  };
}

function result(ordinal: number, findings: Finding[]): ReviewerRouteResult {
  return {
    route: route(ordinal),
    status: "completed",
    report: { verdict: findings.length ? "needs-attention" : "approve", summary: "review", findings },
  };
}

describe("clusterReviewFindings", () => {
  it("clusters compatible cross-route findings and keeps the strongest representative", () => {
    const clusters = clusterReviewFindings([
      result(0, [finding()]),
      result(1, [finding({
        lineStart: 11,
        lineEnd: 13,
        severity: "high",
        confidence: 0.92,
        invariant: "Durable writes must preserve user data",
        issue: "Clearing state before persistence finishes can lose user data",
        evidence: "src/state.ts:11 mutates state before persistence",
        recommendation: "Move the clear after the awaited write",
      })]),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      lineStart: 10,
      lineEnd: 13,
      severity: "high",
      confidence: 0.92,
      votes: 2,
      reviewers: ["p0/m0@high", "p1/m1@high"],
      recommendation: "Move the clear after the awaited write",
    });
    expect(clusters[0].evidence).toHaveLength(2);
  });

  it("uses complete-link and refuses A-B-C bridge merging", () => {
    const clusters = clusterReviewFindings([
      result(0, [finding({ invariant: "alpha beta", issue: "zero" })]),
      result(1, [finding({ invariant: "alpha beta gamma", issue: "one" })]),
      result(2, [finding({ invariant: "beta gamma", issue: "two" })]),
    ], {
      lineTolerance: 2,
      invariantSimilarity: 0.5,
      issueSimilarity: 1,
      minIssueSharedTokens: 1,
      corroboratingIssueSimilarity: 0,
      minCorroboratingIssueTokens: 0,
      minSharedActionTokens: 0,
    });

    expect(clusters).toHaveLength(2);
    expect(clusters.map((cluster) => cluster.votes)).toEqual([2, 1]);
  });

  it("does not let one model's finding array order change cross-route votes", () => {
    const routeZeroFindings = [
      finding({ invariant: "alpha", issue: "zero mechanism" }),
      finding({ invariant: "alpha beta", issue: "one behavior" }),
      finding({ invariant: "beta", issue: "two outcome" }),
    ];
    const routeOne = result(1, [finding({ invariant: "alpha gamma", issue: "three consequence" })]);

    const forward = clusterReviewFindings([result(0, routeZeroFindings), routeOne]);
    const reversed = clusterReviewFindings([result(0, [...routeZeroFindings].reverse()), routeOne]);

    expect(forward.map((cluster) => cluster.votes)).toEqual(reversed.map((cluster) => cluster.votes));
    expect(Math.max(...forward.map((cluster) => cluster.votes))).toBe(1);
  });

  it("counts duplicate findings from one route as one vote", () => {
    const duplicate = finding();
    const clusters = clusterReviewFindings([
      result(0, [duplicate, { ...duplicate, confidence: 0.8 }]),
      result(1, [finding({ confidence: 0.9 })]),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].votes).toBe(2);
    expect(clusters[0].sourceFindingIndexes).toHaveLength(3);
  });

  it("is canonical across route completion order", () => {
    const input = [
      result(1, [finding({ file: "src/z.ts", lineStart: 30, lineEnd: 30 })]),
      result(0, [finding({ file: "src/a.ts", lineStart: 2, lineEnd: 2 })]),
    ];
    expect(clusterReviewFindings(input)).toEqual(clusterReviewFindings([...input].reverse()));
    expect(clusterReviewFindings(input).map((cluster) => cluster.file)).toEqual(["src/a.ts", "src/z.ts"]);
  });

  it("normalizes punctuation and computes deterministic token similarity", () => {
    expect([...normalizedTokens("The durable-write, completes!")]).toEqual(["durable", "write", "completes"]);
    expect([...normalizedTokens("status statuses process processing address addresses class classes access accessing")])
      .toEqual(["status", "process", "address", "class", "access"]);
    expect(normalizedTokens("tenantId")).toEqual(new Set(["tenantid", "tenant", "id"]));
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});
