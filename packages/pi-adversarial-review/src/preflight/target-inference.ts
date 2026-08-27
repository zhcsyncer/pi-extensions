import type { ReviewTargetRequest } from "../types.ts";
import { hasLocalChanges, type GitPreflightState } from "./git-preflight.ts";

export type PreflightIssue =
  | "detached-head"
  | "git-operation"
  | "unmerged-files"
  | "ambiguous-remote"
  | "missing-remote"
  | "ambiguous-default-branch"
  | "missing-default-branch"
  | "missing-relation"
  | "default-branch-ahead"
  | "default-branch-diverged"
  | "default-branch-behind";

export type TargetInference =
  | {
      kind: "auto";
      target: ReviewTargetRequest;
      reason: "feature-branch" | "default-branch-local";
    }
  | { kind: "empty" }
  | {
      kind: "interactive";
      issue: PreflightIssue;
      recommendedTarget?: ReviewTargetRequest;
    };

/** Pure policy: classify repository state without performing UI or Git I/O. */
export function inferReviewTarget(state: GitPreflightState): TargetInference {
  const dirty = hasLocalChanges(state);
  if (!state.branch) {
    return {
      kind: "interactive",
      issue: "detached-head",
      ...(dirty ? { recommendedTarget: { mode: "local" } as const } : {}),
    };
  }
  if (state.operation) {
    return {
      kind: "interactive",
      issue: "git-operation",
      ...(dirty ? { recommendedTarget: { mode: "local" } as const } : {}),
    };
  }
  if (state.workingTree.unmerged) {
    return {
      kind: "interactive",
      issue: "unmerged-files",
      ...(dirty ? { recommendedTarget: { mode: "local" } as const } : {}),
    };
  }
  if (state.remoteAmbiguous) return { kind: "interactive", issue: "ambiguous-remote" };
  if (!state.preferredRemote) {
    return {
      kind: "interactive",
      issue: "missing-remote",
      ...(dirty ? { recommendedTarget: { mode: "local" } as const } : {}),
    };
  }
  if (state.defaultBranchAmbiguous) {
    return { kind: "interactive", issue: "ambiguous-default-branch" };
  }
  if (!state.defaultBranch || !state.defaultBranchRef) {
    return {
      kind: "interactive",
      issue: "missing-default-branch",
      ...(dirty ? { recommendedTarget: { mode: "local" } as const } : {}),
    };
  }
  if (!state.relationAvailable || state.ahead === undefined || state.behind === undefined) {
    return {
      kind: "interactive",
      issue: "missing-relation",
      ...(dirty ? { recommendedTarget: { mode: "local" } as const } : {}),
    };
  }

  if (state.branch !== state.defaultBranch) {
    if (state.ahead === 0 && !dirty) return { kind: "empty" };
    return {
      kind: "auto",
      target: { mode: "base", baseRef: state.defaultBranchRef },
      reason: "feature-branch",
    };
  }

  if (state.ahead > 0) {
    return {
      kind: "interactive",
      issue: state.behind > 0 ? "default-branch-diverged" : "default-branch-ahead",
      recommendedTarget: { mode: "base", baseRef: state.defaultBranchRef },
    };
  }
  if (!dirty) return { kind: "empty" };
  if (state.behind > 0) {
    return {
      kind: "interactive",
      issue: "default-branch-behind",
      recommendedTarget: { mode: "local" },
    };
  }
  return {
    kind: "auto",
    target: { mode: "local" },
    reason: "default-branch-local",
  };
}
