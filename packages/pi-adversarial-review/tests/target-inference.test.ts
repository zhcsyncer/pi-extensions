import { describe, expect, it } from "vitest";
import type { GitPreflightState } from "../src/preflight/git-preflight.ts";
import { inferReviewTarget } from "../src/preflight/target-inference.ts";

function state(overrides: Partial<GitPreflightState> = {}): GitPreflightState {
  return {
    root: "/repo",
    headSha: "a".repeat(40),
    statusSha256: "c".repeat(64),
    branch: "feature/review",
    remotes: ["origin"],
    upstreamRef: "origin/feature/review",
    upstreamRemote: "origin",
    preferredRemote: "origin",
    remoteAmbiguous: false,
    defaultBranch: "main",
    defaultBranchRef: "origin/main",
    defaultBranchSha: "b".repeat(40),
    defaultBranchCandidates: ["origin/main"],
    defaultBranchAmbiguous: false,
    ahead: 2,
    behind: 1,
    relationAvailable: true,
    workingTree: { staged: false, unstaged: true, untracked: false, unmerged: false },
    shallow: false,
    ...overrides,
  };
}

describe("inferReviewTarget", () => {
  it("uses remote default base for a normal feature branch, including local changes", () => {
    expect(inferReviewTarget(state())).toEqual({
      kind: "auto",
      target: { mode: "base", baseRef: "origin/main" },
      reason: "feature-branch",
    });
    expect(inferReviewTarget(state({ upstreamRef: "origin/main" }))).toMatchObject({
      kind: "auto",
      reason: "feature-branch",
    });
  });

  it("uses remote default base for an uncommitted feature branch with no ahead commit", () => {
    expect(inferReviewTarget(state({ ahead: 0, behind: 0 }))).toMatchObject({
      kind: "auto",
      target: { mode: "base", baseRef: "origin/main" },
    });
  });

  it("uses local changes on a synchronized default branch", () => {
    expect(inferReviewTarget(state({
      branch: "main",
      upstreamRef: "origin/main",
      ahead: 0,
      behind: 0,
    }))).toEqual({
      kind: "auto",
      target: { mode: "local" },
      reason: "default-branch-local",
    });
  });

  it("requires interaction for direct or diverged default-branch commits", () => {
    expect(inferReviewTarget(state({
      branch: "main", upstreamRef: "origin/main", ahead: 2, behind: 0,
    }))).toMatchObject({
      kind: "interactive",
      issue: "default-branch-ahead",
      recommendedTarget: { mode: "base", baseRef: "origin/main" },
    });
    expect(inferReviewTarget(state({
      branch: "main", upstreamRef: "origin/main", ahead: 2, behind: 3,
    }))).toMatchObject({
      kind: "interactive",
      issue: "default-branch-diverged",
    });
  });

  it("requires interaction before reviewing dirty default branch based on stale HEAD", () => {
    expect(inferReviewTarget(state({
      branch: "main", upstreamRef: "origin/main", ahead: 0, behind: 3,
    }))).toMatchObject({
      kind: "interactive",
      issue: "default-branch-behind",
      recommendedTarget: { mode: "local" },
    });
  });

  it("requires interaction for detached, in-progress, unmerged, or ambiguous repositories", () => {
    expect(inferReviewTarget(state({ branch: undefined }))).toMatchObject({ issue: "detached-head" });
    expect(inferReviewTarget(state({ operation: "rebase" }))).toMatchObject({ issue: "git-operation" });
    expect(inferReviewTarget(state({
      workingTree: { staged: true, unstaged: true, untracked: false, unmerged: true },
    }))).toMatchObject({ issue: "unmerged-files" });
    expect(inferReviewTarget(state({ preferredRemote: undefined, remoteAmbiguous: true }))).toMatchObject({
      issue: "ambiguous-remote",
    });
    expect(inferReviewTarget(state({
      defaultBranch: undefined,
      defaultBranchRef: undefined,
      defaultBranchCandidates: ["origin/main", "origin/master"],
      defaultBranchAmbiguous: true,
      relationAvailable: false,
      ahead: undefined,
      behind: undefined,
    }))).toMatchObject({ issue: "ambiguous-default-branch" });
  });

  it("stops before model selection when neither branch nor local state changed", () => {
    expect(inferReviewTarget(state({
      ahead: 0,
      behind: 2,
      workingTree: { staged: false, unstaged: false, untracked: false, unmerged: false },
    }))).toEqual({ kind: "empty" });
    expect(inferReviewTarget(state({
      branch: "main",
      upstreamRef: "origin/main",
      ahead: 0,
      behind: 0,
      workingTree: { staged: false, unstaged: false, untracked: false, unmerged: false },
    }))).toEqual({ kind: "empty" });
  });
});
