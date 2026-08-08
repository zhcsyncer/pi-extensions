import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  ADVERSARIAL_REVIEW_MESSAGE_TYPE,
  buildMergedReportText,
  publishMergedReviewReport,
  serializeMergedReviewReport,
} from "../src/output/publish-report.ts";
import type { MergedReviewReport, ReviewerRoute } from "../src/types.ts";

function route(): ReviewerRoute {
  return {
    key: "provider/model@high",
    provider: "provider",
    modelId: "model",
    model: {
      provider: "provider",
      id: "model",
      reasoning: true,
      secretInternal: "omit",
    } as unknown as Model<any>,
    thinking: "high",
    thinkingSource: "user",
    ordinal: 0,
  };
}

function report(overrides: Partial<MergedReviewReport> = {}): MergedReviewReport {
  const reviewer = route();
  return {
    version: 1,
    runId: "run",
    target: {
      mode: "local",
      description: "local changes",
      root: "/repo",
      headSha: "head",
      statusSha256: "status",
      targetSha256: "target",
      changedFiles: ["src/example.ts"],
    },
    charterSource: "builtin",
    charterSha256: "charter",
    requestedRoutes: [reviewer],
    routeResults: [{ route: reviewer, status: "completed", report: { verdict: "approve", summary: "clean", findings: [] } }],
    runtime: { protocolVersion: 3, maxConcurrent: 1, waves: 1 },
    successfulReviewerCount: 1,
    minSuccessfulReviewerCount: 2,
    consensusThreshold: 2,
    advisoryReviewerCount: 0,
    gating: "weighted",
    overall: "inconclusive",
    blocking: [],
    advisory: [],
    contested: [],
    stale: false,
    limitedContext: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    ...overrides,
  };
}

describe("merged report output", () => {
  it("explains inconclusive, runtime waves, and candidate results in plain text", () => {
    expect(buildMergedReportText(report())).toContain("Too few reviewers completed successfully");
    expect(buildMergedReportText(report())).toContain("Routes: 1 · max concurrent: 1 · waves: 1");
    expect(buildMergedReportText(report({
      overall: "candidate-approve",
      successfulReviewerCount: 2,
      requestedRoutes: [route(), { ...route(), key: "p2/m2@high", ordinal: 1 }],
    }))).toContain("candidate result, not final approval");
  });

  it("omits runtime Model objects from durable message details", () => {
    const serialized = serializeMergedReviewReport(report());
    expect(serialized.requestedRoutes[0]).not.toHaveProperty("model");
    expect(serialized.routeResults[0].route).not.toHaveProperty("model");
    expect(JSON.stringify(serialized)).not.toContain("secretInternal");
  });

  it("persists one report and queues it for the next user turn without triggering the main model", () => {
    const sendMessage = vi.fn();
    const appendEntry = vi.fn();
    publishMergedReviewReport(
      { sendMessage, appendEntry } as unknown as ExtensionAPI,
      report(),
      "tui",
    );

    expect(appendEntry).toHaveBeenCalledWith(
      ADVERSARIAL_REVIEW_MESSAGE_TYPE,
      expect.objectContaining({ overall: "inconclusive" }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: ADVERSARIAL_REVIEW_MESSAGE_TYPE,
        display: true,
        details: expect.any(Object),
      }),
      { deliverAs: "nextTurn" },
    );
    expect(sendMessage.mock.calls[0][1]).not.toHaveProperty("triggerTurn");
  });

  it("prints directly without queuing an unusable next-turn message in print mode", () => {
    const sendMessage = vi.fn();
    const appendEntry = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    publishMergedReviewReport(
      { sendMessage, appendEntry } as unknown as ExtensionAPI,
      report(),
      "print",
    );

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Adversarial review: inconclusive"));
    expect(appendEntry).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
