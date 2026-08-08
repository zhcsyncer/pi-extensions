import { readFileSync } from "node:fs";
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { clusterReviewFindings } from "../src/convergence/cluster.ts";
import type {
  Finding,
  FindingCategory,
  ReviewerRoute,
  ReviewerRouteResult,
} from "../src/types.ts";

interface PairFinding {
  file: string;
  lineStart: number;
  lineEnd: number;
  category: FindingCategory;
  invariant: string;
  issue: string;
}

interface LabeledPair {
  id: string;
  label: "same" | "different";
  rationale: string;
  left: PairFinding;
  right: PairFinding;
}

const pairs = JSON.parse(readFileSync(
  new URL("./fixtures/finding-pairs.json", import.meta.url),
  "utf8",
)) as LabeledPair[];

function route(ordinal: number): ReviewerRoute {
  return {
    key: `quality/provider-${ordinal}@high`,
    provider: "quality",
    modelId: `provider-${ordinal}`,
    model: { provider: "quality", id: `provider-${ordinal}`, reasoning: true } as Model<any>,
    thinking: "high",
    thinkingSource: "user",
    ordinal,
  };
}

function finding(input: PairFinding, id: string): Finding {
  return {
    ...input,
    severity: "medium",
    confidence: 0.8,
    evidence: `Human-labeled fixture evidence: ${id}`,
    recommendation: `Correct the invariant represented by ${id}`,
  };
}

function result(ordinal: number, value: Finding): ReviewerRouteResult {
  return {
    route: route(ordinal),
    status: "completed",
    report: { verdict: "needs-attention", summary: "quality fixture", findings: [value] },
  };
}

function predictedLabel(pair: LabeledPair): "same" | "different" {
  const clusters = clusterReviewFindings([
    result(0, finding(pair.left, `${pair.id}:left`)),
    result(1, finding(pair.right, `${pair.id}:right`)),
  ]);
  return clusters.some((cluster) => cluster.votes === 2) ? "same" : "different";
}

describe("human-labeled finding pair quality gate", () => {
  it("contains at least 20 reviewed pairs with both positive and negative labels", () => {
    expect(pairs.length).toBeGreaterThanOrEqual(20);
    expect(pairs.filter((pair) => pair.label === "same").length).toBeGreaterThanOrEqual(8);
    expect(pairs.filter((pair) => pair.label === "different").length).toBeGreaterThanOrEqual(8);
    expect(new Set(pairs.map((pair) => pair.id)).size).toBe(pairs.length);
    expect(pairs.every((pair) => pair.rationale.trim().length > 0)).toBe(true);
  });

  it("keeps precision at 100% and same-issue recall at or above 75%", () => {
    const predictions = pairs.map((pair) => ({
      id: pair.id,
      expected: pair.label,
      actual: predictedLabel(pair),
    }));
    const falsePositives = predictions.filter(({ expected, actual }) => (
      expected === "different" && actual === "same"
    ));
    const samePairs = predictions.filter(({ expected }) => expected === "same");
    const truePositives = samePairs.filter(({ actual }) => actual === "same").length;
    const recall = truePositives / samePairs.length;

    // False merges overstate independent consensus and can hide one of two
    // material issues, so precision is non-negotiable. Conservative splits are
    // tolerated only up to this explicit recall floor and remain visible as advisories.
    expect(falsePositives).toEqual([]);
    expect(recall).toBeGreaterThanOrEqual(0.75);
  });
});
