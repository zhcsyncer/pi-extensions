import { describe, expect, it } from "vitest";
import { ADVERSARIAL_REVIEW_RESULT_TYPE } from "../src/output/publish-report.ts";
import {
  completedReviewSpansFromSessionEntries,
  reviewedCommitShas,
  reviewTargetSpan,
  sessionBranchEntries,
} from "../src/output/reviewed-commits.ts";

const latest = "1".repeat(40);
const second = "2".repeat(40);
const oldest = "3".repeat(40);
const base = "b".repeat(40);

const starts = [
  { commitSha: latest, parentSha: second },
  { commitSha: second, parentSha: oldest },
  { commitSha: oldest, parentSha: base },
];

function resultEntry(overall: string, target: Record<string, unknown>) {
  return {
    type: "custom" as const,
    customType: ADVERSARIAL_REVIEW_RESULT_TYPE,
    data: { overall, target },
  };
}

describe("reviewed commit replay", () => {
  it("ignores local-only targets and incomplete overall states", () => {
    expect(reviewTargetSpan({ mode: "local", headSha: latest })).toBeUndefined();
    expect(completedReviewSpansFromSessionEntries([
      resultEntry("cancelled", { mode: "base", headSha: latest, baseSha: base }),
      resultEntry("failed", { mode: "base", headSha: latest, baseSha: base }),
      resultEntry("inconclusive", { mode: "base", headSha: latest, baseSha: base }),
      resultEntry("needs-adjudication", { mode: "local", headSha: latest }),
    ])).toEqual([]);
  });

  it("covers first-parent commits inside a completed base or range span", () => {
    const baseSpan = reviewTargetSpan({ mode: "base", headSha: second, baseSha: base });
    expect(baseSpan).toEqual({ inclusiveRight: second, exclusiveLeft: base });
    expect([...reviewedCommitShas(starts, [baseSpan!])]).toEqual([second, oldest]);

    const rangeSpan = reviewTargetSpan({
      mode: "range",
      headSha: latest,
      fromSha: second,
      toSha: latest,
    });
    expect([...reviewedCommitShas(starts, [rangeSpan!])]).toEqual([latest]);
  });

  it("marks only the endpoint when a completed review has no exclusive left", () => {
    expect([...reviewedCommitShas(starts, [{ inclusiveRight: second }])]).toEqual([second]);
  });

  it("does not mark older picker rows when the left bound is not on the list", () => {
    const peer = "c".repeat(40);
    expect([...reviewedCommitShas(starts, [{
      inclusiveRight: latest,
      exclusiveLeft: peer,
    }])]).toEqual([latest]);
  });

  it("replays completed session entries and ignores other custom types", () => {
    const spans = completedReviewSpansFromSessionEntries([
      { type: "message", customType: ADVERSARIAL_REVIEW_RESULT_TYPE, data: { overall: "needs-adjudication" } },
      resultEntry("candidate-approve", { mode: "base", headSha: second, baseSha: base }),
      { type: "custom", customType: "other", data: { overall: "needs-adjudication", target: { mode: "base", headSha: latest, baseSha: base } } },
    ]);
    expect(reviewedCommitShas(starts, spans).has(latest)).toBe(false);
    expect(reviewedCommitShas(starts, spans).has(second)).toBe(true);
    expect(reviewedCommitShas(starts, spans).has(oldest)).toBe(true);
  });

  it("treats a missing session branch as empty", () => {
    expect([...sessionBranchEntries(undefined)]).toEqual([]);
    expect([...sessionBranchEntries({ getBranch: () => { throw new Error("closed"); } })]).toEqual([]);
  });
});
