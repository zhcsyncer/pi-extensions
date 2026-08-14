import { describe, expect, it, vi } from "vitest";
import type { ReviewTargetRequest } from "../src/types.ts";

const COMMITTED_AT = "2026-08-14T11:23:45+08:00";
const COMMIT_TIME_LABEL = "2026-08-14 11:23:45 +08:00";

vi.mock("../src/input/freeze-input.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/input/freeze-input.ts")>();
  return {
    ...actual,
    fingerprintReviewTarget: vi.fn(async ({ cwd, target }: {
      cwd: string;
      target: ReviewTargetRequest;
    }) => ({
      root: cwd,
      headSha: "a".repeat(40),
      statusSha256: "c".repeat(64),
      targetSha256: "d".repeat(64),
      inputSize: { bytes: 1024, lines: 20 },
      inputSha256: "e".repeat(64),
      resolvedTarget: target.mode === "base"
        ? {
            mode: "base" as const,
            baseRef: target.baseRef,
            baseSha: "b".repeat(40),
            headSha: "a".repeat(40),
          }
        : target.mode === "range"
          ? {
              mode: "range" as const,
              fromRef: target.fromRef,
              toRef: target.toRef,
              fromSha: "b".repeat(40),
              toSha: target.toRef === "HEAD" ? "a".repeat(40) : "b".repeat(40),
              currentHeadSha: "a".repeat(40),
              currentBranch: "feature/review",
              checkoutEstimate: { entries: 1, logicalBytes: "1" },
            }
          : { mode: "local" as const },
      targetRefs: target.mode === "base"
        ? [{ ref: target.baseRef, sha: "b".repeat(40) }]
        : target.mode === "range"
          ? [
              { ref: target.fromRef, sha: "b".repeat(40) },
              { ref: target.toRef, sha: target.toRef === "HEAD" ? "a".repeat(40) : "b".repeat(40) },
            ]
          : [],
    })),
  };
});

import { ReviewCommandError } from "../src/command/parse-args.ts";
import {
  EmptyReviewInputError,
  OversizedReviewInputError,
  ReviewInputError,
} from "../src/input/errors.ts";
import { fingerprintReviewTarget } from "../src/input/freeze-input.ts";
import type { GitPreflightState } from "../src/preflight/git-preflight.ts";
import {
  resolveReviewPreflight,
  revalidateReviewPreflight,
} from "../src/preflight/resolve-preflight.ts";

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
    workingTree: { staged: false, unstaged: false, untracked: false, unmerged: false },
    shallow: false,
    ...overrides,
  };
}

function fingerprintWithSize(bytes: number, lines: number) {
  return vi.fn(async ({ cwd, target }: { cwd: string; target: ReviewTargetRequest }) => ({
    root: cwd,
    headSha: "a".repeat(40),
    statusSha256: "c".repeat(64),
    targetSha256: "d".repeat(64),
    inputSize: { bytes, lines },
    inputSha256: "e".repeat(64),
    resolvedTarget: target.mode === "base"
      ? {
          mode: "base" as const,
          baseRef: target.baseRef,
          baseSha: "b".repeat(40),
          headSha: "a".repeat(40),
        }
      : target.mode === "range"
        ? {
            mode: "range" as const,
            fromRef: target.fromRef,
            toRef: target.toRef,
            fromSha: "b".repeat(40),
            toSha: target.toRef === "HEAD" ? "a".repeat(40) : "b".repeat(40),
            currentHeadSha: "a".repeat(40),
            currentBranch: "feature/review",
            checkoutEstimate: { entries: 1, logicalBytes: "1" },
          }
        : { mode: "local" as const },
    targetRefs: target.mode === "base"
      ? [{ ref: target.baseRef, sha: "b".repeat(40) }]
      : target.mode === "range"
        ? [
            { ref: target.fromRef, sha: "b".repeat(40) },
            { ref: target.toRef, sha: target.toRef === "HEAD" ? "a".repeat(40) : "b".repeat(40) },
          ]
        : [],
  }));
}

function context(mode: "tui" | "json" = "tui", select?: (title: string, options: string[]) => unknown) {
  return {
    cwd: "/repo",
    mode,
    ui: {
      select: vi.fn(select ?? (async (_title: string, options: string[]) => options[0])),
      input: vi.fn(async () => undefined),
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
  } as any;
}

describe("resolveReviewPreflight", () => {
  it("selects the earliest included first-parent commit while fixing the endpoint at captured HEAD", async () => {
    const headSha = "a".repeat(40);
    const latestSha = "1".repeat(40);
    const secondSha = "2".repeat(40);
    const parentSha = "b".repeat(40);
    const ctx = context("tui", async (title, options) => {
      expect(title).toContain(`HEAD ${headSha.slice(0, 12)}`);
      expect(title).toContain("Choose the earliest commit to include");
      return options.find((option) => option.startsWith(
        `Start ${secondSha.slice(0, 7)} · reviews 2 commits`,
      ));
    });
    const listRangeStarts = vi.fn(async () => ({
      truncated: false,
      mergeBaseSha: "b".repeat(40),
      starts: [
        {
          commitSha: latestSha,
          parentSha: secondSha,
          committedAt: COMMITTED_AT,
          subject: "finalize release",
          commitCount: 1,
        },
        {
          commitSha: secondSha,
          parentSha,
          committedAt: COMMITTED_AT,
          subject: "add worker handoff",
          commitCount: 2,
        },
      ],
    }));
    const fingerprintTarget = vi.fn(async ({ cwd, target }: {
      cwd: string;
      target: ReviewTargetRequest;
    }) => ({
      root: cwd,
      headSha,
      statusSha256: "c".repeat(64),
      targetSha256: "d".repeat(64),
      inputSize: { bytes: 4_096, lines: 80 },
      inputSha256: "e".repeat(64),
      resolvedTarget: target.mode === "range"
        ? {
            mode: "range" as const,
            fromRef: target.fromRef,
            toRef: target.toRef,
            fromSha: target.fromRef,
            toSha: target.toRef,
            currentHeadSha: headSha,
            currentBranch: "feature/review",
            checkoutEstimate: { entries: 1, logicalBytes: "1" },
          }
        : { mode: "local" as const },
      targetRefs: target.mode === "range"
        ? [{ ref: target.fromRef, sha: target.fromRef }, { ref: target.toRef, sha: target.toRef }]
        : [],
    }));

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: true,
      interactiveRange: true,
      inspect: vi.fn(async () => state({ headSha })),
      fetch: vi.fn(async () => ({
        status: "succeeded" as const,
        remote: "origin",
        timedOut: false,
      })),
      listRangeStarts,
      fingerprintTarget,
    });

    expect(result).toMatchObject({
      target: { mode: "range", fromRef: parentSha, toRef: headSha },
      audit: {
        selection: "interactive",
        fetchStatus: "succeeded",
        selectedCommitCount: 2,
      },
      inputSize: { bytes: 4_096, lines: 80 },
    });
    expect(listRangeStarts).toHaveBeenCalledWith(
      "/repo",
      headSha,
      expect.objectContaining({ boundarySha: "b".repeat(40) }),
    );
    expect(ctx.ui.select).toHaveBeenCalledWith(
      expect.stringContaining("each row is one continuous review range"),
      expect.arrayContaining([
        `Start ${latestSha.slice(0, 7)} · reviews 1 commit · ${COMMIT_TIME_LABEL} · finalize release`,
        `Start ${secondSha.slice(0, 7)} · reviews 2 commits · ${COMMIT_TIME_LABEL} · add worker handoff`,
      ]),
      undefined,
    );
  });

  it.each([3, 6])("selects any continuous latest-%i-commit range from the commit line", async (commitCount) => {
    const headSha = "a".repeat(40);
    const starts = Array.from({ length: 6 }, (_, index) => ({
      commitSha: String(index + 1).repeat(40),
      parentSha: String.fromCharCode(98 + index).repeat(40),
      committedAt: COMMITTED_AT,
      subject: `commit ${index + 1}`,
      commitCount: index + 1,
    }));
    const selected = starts[commitCount - 1];
    const ctx = context("tui", async (_title, options) => (
      options.find((option) => option.startsWith(
        `Start ${selected.commitSha.slice(0, 7)} · reviews ${commitCount} commits`,
      ))
    ));

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: true,
      interactiveRange: true,
      inspect: vi.fn(async () => state({
        headSha,
        remotes: [],
        upstreamRef: undefined,
        upstreamRemote: undefined,
        preferredRemote: undefined,
        remoteAmbiguous: false,
        defaultBranch: undefined,
        defaultBranchRef: undefined,
        defaultBranchSha: undefined,
        defaultBranchCandidates: [],
      })),
      listRangeStarts: vi.fn(async () => ({ truncated: false, starts })),
      fingerprintTarget: vi.fn(async ({ cwd, target }: {
        cwd: string;
        target: ReviewTargetRequest;
      }) => ({
        root: cwd,
        headSha,
        statusSha256: "c".repeat(64),
        targetSha256: "d".repeat(64),
        inputSize: { bytes: 4_096, lines: 80 },
        inputSha256: "e".repeat(64),
        resolvedTarget: target.mode === "range"
          ? {
              mode: "range" as const,
              fromRef: target.fromRef,
              toRef: target.toRef,
              fromSha: target.fromRef,
              toSha: target.toRef,
              currentHeadSha: headSha,
              currentBranch: "feature/review",
              checkoutEstimate: { entries: 1, logicalBytes: "1" },
            }
          : { mode: "local" as const },
        targetRefs: target.mode === "range"
          ? [{ ref: target.fromRef, sha: target.fromRef }, { ref: target.toRef, sha: target.toRef }]
          : [],
      })),
    });

    expect(result).toMatchObject({
      target: {
        mode: "range",
        fromRef: selected.parentSha,
        toRef: headSha,
      },
      audit: { selection: "interactive", selectedCommitCount: commitCount },
    });
  });

  it("reviews all selected commits together after explicit soft-limit confirmation", async () => {
    const headSha = "a".repeat(40);
    const starts = Array.from({ length: 6 }, (_, index) => ({
      commitSha: String(index + 1).repeat(40),
      parentSha: String.fromCharCode(98 + index).repeat(40),
      committedAt: COMMITTED_AT,
      subject: `commit ${index + 1}`,
      commitCount: index + 1,
    }));
    let interaction = 0;
    const ctx = context("tui", async (_title, options) => {
      interaction++;
      if (interaction === 1) {
        return options.find((option) => option.includes("reviews 6 commits"));
      }
      return options.find((option) => option === "Review all 6 selected commits together");
    });
    const suggestRanges = vi.fn();

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: true,
      interactiveRange: true,
      inspect: vi.fn(async () => state({
        headSha,
        remotes: [],
        upstreamRef: undefined,
        upstreamRemote: undefined,
        preferredRemote: undefined,
        remoteAmbiguous: false,
        defaultBranch: undefined,
        defaultBranchRef: undefined,
        defaultBranchSha: undefined,
        defaultBranchCandidates: [],
      })),
      listRangeStarts: vi.fn(async () => ({ truncated: false, starts })),
      fingerprintTarget: fingerprintWithSize(300 * 1024, 6_000),
      suggestRanges,
    });

    expect(result).toMatchObject({
      target: {
        mode: "range",
        fromRef: starts[5].parentSha,
        toRef: headSha,
      },
      audit: {
        selection: "interactive",
        selectedCommitCount: 6,
        largeInput: true,
      },
      largeInput: true,
    });
    expect(suggestRanges).not.toHaveBeenCalled();
    expect(ctx.ui.select).toHaveBeenLastCalledWith(
      expect.stringContaining("selected range contains 6 commits"),
      [
        "Review all 6 selected commits together",
        "Choose a closer start commit",
        "Cancel review",
      ],
      undefined,
    );
  });

  it("returns to the same commit line and changes six selected commits to three", async () => {
    const headSha = "a".repeat(40);
    const starts = Array.from({ length: 6 }, (_, index) => ({
      commitSha: String(index + 1).repeat(40),
      parentSha: String.fromCharCode(98 + index).repeat(40),
      committedAt: COMMITTED_AT,
      subject: `commit ${index + 1}`,
      commitCount: index + 1,
    }));
    let interaction = 0;
    const seenOptions: string[][] = [];
    const ctx = context("tui", async (_title, options) => {
      seenOptions.push(options);
      interaction++;
      if (interaction === 1) return options.find((option) => option.includes("reviews 6 commits"));
      if (interaction === 2) return "Choose a closer start commit";
      return options.find((option) => option.includes("reviews 3 commits"));
    });
    const fingerprintTarget = vi.fn(async ({ cwd, target }: {
      cwd: string;
      target: ReviewTargetRequest;
    }) => {
      const selected = starts.find(({ parentSha }) => (
        target.mode === "range" && target.fromRef === parentSha
      ));
      const large = selected?.commitCount === 6;
      return {
        root: cwd,
        headSha,
        statusSha256: "c".repeat(64),
        targetSha256: "d".repeat(64),
        inputSize: large ? { bytes: 300 * 1024, lines: 6_000 } : { bytes: 80 * 1024, lines: 900 },
        inputSha256: "e".repeat(64),
        resolvedTarget: target.mode === "range"
          ? {
              mode: "range" as const,
              fromRef: target.fromRef,
              toRef: target.toRef,
              fromSha: target.fromRef,
              toSha: target.toRef,
              currentHeadSha: headSha,
              currentBranch: "feature/review",
              checkoutEstimate: { entries: 1, logicalBytes: "1" },
            }
          : { mode: "local" as const },
        targetRefs: target.mode === "range"
          ? [{ ref: target.fromRef, sha: target.fromRef }, { ref: target.toRef, sha: target.toRef }]
          : [],
      };
    });

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: true,
      interactiveRange: true,
      inspect: vi.fn(async () => state({
        headSha,
        remotes: [],
        upstreamRef: undefined,
        upstreamRemote: undefined,
        preferredRemote: undefined,
        remoteAmbiguous: false,
        defaultBranch: undefined,
        defaultBranchRef: undefined,
        defaultBranchSha: undefined,
        defaultBranchCandidates: [],
      })),
      listRangeStarts: vi.fn(async () => ({ truncated: false, starts })),
      fingerprintTarget,
      suggestRanges: vi.fn(() => {
        throw new Error("batch planning must not run");
      }),
    });

    expect(result).toMatchObject({
      target: {
        mode: "range",
        fromRef: starts[2].parentSha,
        toRef: headSha,
      },
      audit: { selectedCommitCount: 3 },
      largeInput: false,
    });
    expect(fingerprintTarget).toHaveBeenCalledTimes(2);
    expect(seenOptions[2]).toEqual(expect.arrayContaining([
      expect.stringContaining("reviews 1 commit"),
      expect.stringContaining("reviews 2 commits"),
      expect.stringContaining("reviews 3 commits"),
    ]));
    expect(seenOptions[2]).not.toEqual(expect.arrayContaining([
      expect.stringContaining("reviews 6 commits"),
    ]));
  });

  it("forces a closer start after a hard limit without generating a batch plan", async () => {
    const headSha = "a".repeat(40);
    const starts = Array.from({ length: 6 }, (_, index) => ({
      commitSha: String(index + 1).repeat(40),
      parentSha: String.fromCharCode(98 + index).repeat(40),
      committedAt: COMMITTED_AT,
      subject: `commit ${index + 1}`,
      commitCount: index + 1,
    }));
    let interaction = 0;
    const ctx = context("tui", async (title, options) => {
      interaction++;
      if (interaction === 1) return options.find((option) => option.includes("reviews 6 commits"));
      expect(title).toContain("selected 6 commits cannot be reviewed together");
      expect(options).not.toEqual(expect.arrayContaining([
        expect.stringContaining("commit plan"),
      ]));
      return options.find((option) => option.includes("reviews 3 commits"));
    });
    const hardFailure = new OversizedReviewInputError({
      bytes: { limit: 1024 * 1024, actual: 2 * 1024 * 1024 },
    });
    const fingerprintTarget = vi.fn()
      .mockRejectedValueOnce(hardFailure)
      .mockResolvedValueOnce({
        root: "/repo",
        headSha,
        statusSha256: "c".repeat(64),
        targetSha256: "d".repeat(64),
        inputSize: { bytes: 80 * 1024, lines: 900 },
        inputSha256: "e".repeat(64),
        resolvedTarget: {
          mode: "range" as const,
          fromRef: starts[2].parentSha,
          toRef: headSha,
          fromSha: starts[2].parentSha,
          toSha: headSha,
          currentHeadSha: headSha,
          currentBranch: "feature/review",
          checkoutEstimate: { entries: 1, logicalBytes: "1" },
        },
        targetRefs: [
          { ref: starts[2].parentSha, sha: starts[2].parentSha },
          { ref: headSha, sha: headSha },
        ],
      });
    const suggestRanges = vi.fn();

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: true,
      interactiveRange: true,
      inspect: vi.fn(async () => state({
        headSha,
        remotes: [],
        upstreamRef: undefined,
        upstreamRemote: undefined,
        preferredRemote: undefined,
        remoteAmbiguous: false,
        defaultBranch: undefined,
        defaultBranchRef: undefined,
        defaultBranchSha: undefined,
        defaultBranchCandidates: [],
      })),
      listRangeStarts: vi.fn(async () => ({ truncated: false, starts })),
      fingerprintTarget,
      suggestRanges,
    });

    expect(result).toMatchObject({
      target: {
        mode: "range",
        fromRef: starts[2].parentSha,
        toRef: headSha,
      },
      audit: { selectedCommitCount: 3 },
    });
    expect(suggestRanges).not.toHaveBeenCalled();
    expect(fingerprintTarget.mock.calls[0]?.[0]).toMatchObject({ suggestRangesOnOversize: false });
  });

  it("cancels interactive range selection before fingerprinting", async () => {
    const fingerprintTarget = vi.fn();
    await expect(resolveReviewPreflight({
      ctx: context("tui", async () => undefined),
      target: { mode: "local" },
      targetExplicit: true,
      interactiveRange: true,
      inspect: vi.fn(async () => state()),
      fetch: vi.fn(async () => ({
        status: "succeeded" as const,
        remote: "origin",
        timedOut: false,
      })),
      listRangeStarts: vi.fn(async () => ({
        truncated: false,
        starts: [{
          commitSha: "a".repeat(40),
          parentSha: "b".repeat(40),
          committedAt: COMMITTED_AT,
          subject: "latest",
          commitCount: 1,
        }],
      })),
      fingerprintTarget,
    })).resolves.toBeUndefined();
    expect(fingerprintTarget).not.toHaveBeenCalled();
  });

  it("rejects interactive range outside TUI or unsafe repository states", async () => {
    const base = {
      target: { mode: "local" as const },
      targetExplicit: true,
      interactiveRange: true,
      listRangeStarts: vi.fn(async () => ({ starts: [], truncated: false })),
    };
    await expect(resolveReviewPreflight({
      ...base,
      ctx: context("json"),
      inspect: vi.fn(async () => state()),
    })).rejects.toThrow("requires TUI mode");
    await expect(resolveReviewPreflight({
      ...base,
      ctx: context(),
      inspect: vi.fn(async () => state({ branch: undefined })),
    })).rejects.toThrow("named branch");
    await expect(resolveReviewPreflight({
      ...base,
      ctx: context(),
      inspect: vi.fn(async () => state({ operation: "rebase" })),
    })).rejects.toThrow("Git operation");
    await expect(resolveReviewPreflight({
      ...base,
      ctx: context(),
      inspect: vi.fn(async () => state({
        workingTree: { staged: false, unstaged: false, untracked: false, unmerged: true },
      })),
    })).rejects.toThrow("unmerged files");
  });

  it("warns when interactive range history is truncated", async () => {
    const ctx = context();
    await resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: true,
      interactiveRange: true,
      inspect: vi.fn(async () => state()),
      fetch: vi.fn(async () => ({
        status: "succeeded" as const,
        remote: "origin",
        timedOut: false,
      })),
      listRangeStarts: vi.fn(async () => ({
        truncated: true,
        starts: [{
          commitSha: "a".repeat(40),
          parentSha: "b".repeat(40),
          committedAt: COMMITTED_AT,
          subject: "latest",
          commitCount: 1,
        }],
      })),
    });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("latest 1 first-parent commits"),
      "warning",
    );
  });

  it("warns for shallow history and requires explicit exclusion of dirty local work", async () => {
    const ctx = context();
    await resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: true,
      interactiveRange: true,
      inspect: vi.fn(async () => state({
        remotes: [],
        upstreamRef: undefined,
        upstreamRemote: undefined,
        preferredRemote: undefined,
        remoteAmbiguous: false,
        defaultBranch: undefined,
        defaultBranchRef: undefined,
        defaultBranchSha: undefined,
        defaultBranchCandidates: [],
        shallow: true,
        workingTree: { staged: true, unstaged: false, untracked: true, unmerged: false },
      })),
      listRangeStarts: vi.fn(async () => ({
        truncated: false,
        starts: [{
          commitSha: "a".repeat(40),
          parentSha: "b".repeat(40),
          committedAt: COMMITTED_AT,
          subject: "latest",
          commitCount: 1,
        }],
      })),
    });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("default-branch boundary could not be proven"),
      "warning",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("shallow repository"),
      "warning",
    );
    expect(ctx.ui.select).toHaveBeenCalledWith(
      expect.stringContaining("commit range contains committed snapshots only"),
      [
        "Continue with committed range only",
        "Cancel review and commit changes first",
      ],
      undefined,
    );
  });

  it("fetches upstream remote and infers feature branch committed + local target", async () => {
    const ctx = context();
    const inspect = vi.fn(async () => state());
    const fetch = vi.fn(async () => ({ status: "succeeded" as const, remote: "origin", timedOut: false }));

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: false,
      inspect,
      fetch,
    });

    expect(fetch).toHaveBeenCalledWith("/repo", "origin", expect.any(Object));
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      target: { mode: "base", baseRef: "origin/main" },
      audit: {
        selection: "inferred",
        fetchStatus: "succeeded",
        branch: "feature/review",
        remote: "origin",
        fetchedRemotes: ["origin"],
        ahead: 2,
        behind: 1,
      },
    });
    expect(result?.summary).toContain("committed changes from origin/main through HEAD, plus local changes");
  });

  it("uses the fixed-HEAD commit line instead of a batch plan for a large inferred feature target", async () => {
    const headSha = "a".repeat(40);
    const defaultBranchSha = "b".repeat(40);
    const selectedCommitSha = "6".repeat(40);
    const selectedParentSha = "5".repeat(40);
    const interactions: Array<{ title: string; options: string[] }> = [];
    const ctx = context("tui", async (title, options) => {
      interactions.push({ title, options: [...options] });
      return options.find((option) => option === "Choose a continuous range ending at HEAD") ??
        options.find((option) => option.startsWith(
          `Start ${selectedCommitSha.slice(0, 7)} · reviews 6 commits`,
        )) ??
        options.find((option) => option === "Review all 6 selected commits together");
    });
    const listRangeStarts = vi.fn(async () => ({
      truncated: false,
      mergeBaseSha: defaultBranchSha,
      starts: [
        {
          commitSha: headSha,
          parentSha: "8".repeat(40),
          committedAt: COMMITTED_AT,
          subject: "latest",
          commitCount: 1,
        },
        {
          commitSha: selectedCommitSha,
          parentSha: selectedParentSha,
          committedAt: COMMITTED_AT,
          subject: "selected start",
          commitCount: 6,
        },
      ],
    }));
    const suggestRanges = vi.fn();
    const fingerprintTarget = vi.fn(async ({ cwd, target, suggestRangesOnOversize }: {
      cwd: string;
      target: ReviewTargetRequest;
      suggestRangesOnOversize?: boolean;
    }) => {
      expect(suggestRangesOnOversize).toBe(false);
      const selected = target.mode === "range";
      return {
        root: cwd,
        headSha,
        statusSha256: "c".repeat(64),
        targetSha256: selected ? "f".repeat(64) : "d".repeat(64),
        inputSize: selected
          ? { bytes: 403_384, lines: 8_805 }
          : { bytes: 471_631, lines: 11_338 },
        inputSha256: selected ? "9".repeat(64) : "e".repeat(64),
        resolvedTarget: target.mode === "range"
          ? {
              mode: "range" as const,
              fromRef: target.fromRef,
              toRef: target.toRef,
              fromSha: target.fromRef,
              toSha: target.toRef,
              currentHeadSha: headSha,
              currentBranch: "feature/review",
              checkoutEstimate: { entries: 1, logicalBytes: "1" },
            }
          : {
              mode: "base" as const,
              baseRef: "origin/main",
              baseSha: defaultBranchSha,
              headSha,
            },
        targetRefs: target.mode === "range"
          ? [
              { ref: target.fromRef, sha: target.fromRef },
              { ref: target.toRef, sha: target.toRef },
            ]
          : [{ ref: "origin/main", sha: defaultBranchSha }],
      };
    });

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: false,
      inspect: vi.fn(async () => state({
        headSha,
        defaultBranchSha,
        ahead: 9,
        behind: 0,
        workingTree: { staged: false, unstaged: false, untracked: false, unmerged: false },
      })),
      fetch: vi.fn(async () => ({ status: "succeeded" as const, remote: "origin", timedOut: false })),
      fingerprintTarget,
      listRangeStarts,
      suggestRanges,
    });

    expect(result).toMatchObject({
      target: { mode: "range", fromRef: selectedParentSha, toRef: headSha },
      audit: {
        selection: "interactive",
        selectedCommitCount: 6,
        inputBytes: 403_384,
        inputLines: 8_805,
        largeInput: true,
      },
      largeInput: true,
    });
    expect(listRangeStarts).toHaveBeenCalledOnce();
    expect(suggestRanges).not.toHaveBeenCalled();
    expect(interactions.some(({ title }) => title.includes("Commit review plan"))).toBe(false);
    expect(interactions.some(({ options }) => options.includes("Review by commit plan"))).toBe(false);
  });

  it("does not offer an empty range or automatic plan when a feature branch has only local changes", async () => {
    const interactions: Array<{ title: string; options: string[] }> = [];
    const ctx = context("tui", async (title, options) => {
      interactions.push({ title, options: [...options] });
      return options.find((option) => option === "Review the whole target") ??
        options.find((option) => option === "Continue and include uncommitted changes");
    });
    const listRangeStarts = vi.fn();
    const suggestRanges = vi.fn();
    const fingerprintTarget = vi.fn(async ({ cwd, target, suggestRangesOnOversize }: {
      cwd: string;
      target: ReviewTargetRequest;
      suggestRangesOnOversize?: boolean;
    }) => {
      expect(suggestRangesOnOversize).toBe(false);
      return {
        root: cwd,
        headSha: "a".repeat(40),
        statusSha256: "c".repeat(64),
        targetSha256: "d".repeat(64),
        inputSize: { bytes: 300 * 1024, lines: 6_000 },
        inputSha256: "e".repeat(64),
        resolvedTarget: {
          mode: "base" as const,
          baseRef: "origin/main",
          baseSha: "b".repeat(40),
          headSha: "a".repeat(40),
        },
        targetRefs: [{ ref: "origin/main", sha: "b".repeat(40) }],
      };
    });

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: false,
      inspect: vi.fn(async () => state({
        ahead: 0,
        behind: 0,
        workingTree: { staged: false, unstaged: true, untracked: false, unmerged: false },
      })),
      fetch: vi.fn(async () => ({ status: "succeeded" as const, remote: "origin", timedOut: false })),
      fingerprintTarget,
      listRangeStarts,
      suggestRanges,
    });

    expect(result).toMatchObject({
      target: { mode: "base", baseRef: "origin/main" },
      largeInput: true,
    });
    expect(interactions[0]?.options).toEqual([
      "Review the whole target",
      "Cancel review",
    ]);
    expect(listRangeStarts).not.toHaveBeenCalled();
    expect(suggestRanges).not.toHaveBeenCalled();
  });

  it("opens the fixed-HEAD commit line directly when an inferred target exceeds the hard limit", async () => {
    const headSha = "a".repeat(40);
    const defaultBranchSha = "b".repeat(40);
    const selectedCommitSha = "3".repeat(40);
    const selectedParentSha = "2".repeat(40);
    const interactions: Array<{ title: string; options: string[] }> = [];
    const ctx = context("tui", async (title, options) => {
      interactions.push({ title, options: [...options] });
      return options.find((option) => option.startsWith(
        `Start ${selectedCommitSha.slice(0, 7)} · reviews 3 commits`,
      ));
    });
    const hardFailure = new OversizedReviewInputError({
      bytes: { limit: 1024 * 1024, actual: 2 * 1024 * 1024 },
    });
    const listRangeStarts = vi.fn(async () => ({
      truncated: false,
      mergeBaseSha: defaultBranchSha,
      starts: [{
        commitSha: selectedCommitSha,
        parentSha: selectedParentSha,
        committedAt: COMMITTED_AT,
        subject: "bounded start",
        commitCount: 3,
      }],
    }));
    const suggestRanges = vi.fn();
    const fingerprintTarget = vi.fn(async ({ cwd, target, suggestRangesOnOversize }: {
      cwd: string;
      target: ReviewTargetRequest;
      suggestRangesOnOversize?: boolean;
    }) => {
      expect(suggestRangesOnOversize).toBe(false);
      if (target.mode === "base") throw hardFailure;
      if (target.mode !== "range") throw new Error("expected range after hard-limit re-selection");
      return {
        root: cwd,
        headSha,
        statusSha256: "c".repeat(64),
        targetSha256: "f".repeat(64),
        inputSize: { bytes: 120 * 1024, lines: 2_400 },
        inputSha256: "9".repeat(64),
        resolvedTarget: {
          mode: "range" as const,
          fromRef: target.fromRef,
          toRef: target.toRef,
          fromSha: target.fromRef,
          toSha: target.toRef,
          currentHeadSha: headSha,
          currentBranch: "feature/review",
          checkoutEstimate: { entries: 1, logicalBytes: "1" },
        },
        targetRefs: [
          { ref: target.fromRef, sha: target.fromRef },
          { ref: target.toRef, sha: target.toRef },
        ],
      };
    });

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: false,
      inspect: vi.fn(async () => state({
        headSha,
        defaultBranchSha,
        ahead: 9,
        behind: 0,
        workingTree: { staged: false, unstaged: false, untracked: false, unmerged: false },
      })),
      fetch: vi.fn(async () => ({ status: "succeeded" as const, remote: "origin", timedOut: false })),
      fingerprintTarget,
      listRangeStarts,
      suggestRanges,
    });

    expect(result).toMatchObject({
      target: { mode: "range", fromRef: selectedParentSha, toRef: headSha },
      audit: { selection: "interactive", selectedCommitCount: 3 },
      largeInput: false,
    });
    expect(listRangeStarts).toHaveBeenCalledOnce();
    expect(suggestRanges).not.toHaveBeenCalled();
    expect(interactions[0]?.title).toContain("exceeds the safety limit");
    expect(interactions.some(({ title }) => title.includes("Commit review plan"))).toBe(false);
    expect(interactions.some(({ options }) => options.includes("Review by commit plan"))).toBe(false);
  });

  it("infers local target on synchronized default branch after fetch", async () => {
    const ctx = context();
    const inspect = vi.fn(async () => state({
      branch: "main",
      upstreamRef: "origin/main",
      ahead: 0,
      behind: 0,
      workingTree: { staged: false, unstaged: true, untracked: false, unmerged: false },
    }));

    await expect(resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: false,
      inspect,
      fetch: vi.fn(async () => ({ status: "succeeded" as const, remote: "origin", timedOut: false })),
    })).resolves.toMatchObject({
      target: { mode: "local" },
      audit: { selection: "inferred", fetchStatus: "succeeded" },
    });
  });

  it("asks before reviewing local commits made directly on the default branch", async () => {
    const ctx = context("tui", async (_title, options) => (
      options.find((option) => option.includes("committed + local"))
    ));
    const inspect = vi.fn(async () => state({
      branch: "main", upstreamRef: "origin/main", ahead: 2, behind: 0,
    }));

    await expect(resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: false,
      inspect,
      fetch: vi.fn(async () => ({ status: "succeeded" as const, remote: "origin", timedOut: false })),
    })).resolves.toMatchObject({
      target: { mode: "base", baseRef: "origin/main" },
      audit: { selection: "interactive" },
    });
    expect(ctx.ui.select).toHaveBeenCalledWith(
      expect.stringContaining("default branch contains local commits"),
      expect.any(Array),
      undefined,
    );
  });

  it("retries fetch in TUI and never exposes raw fetch stderr", async () => {
    const ctx = context("tui", async (_title, options) => options.find((option) => option === "Retry fetch"));
    const fetch = vi.fn()
      .mockResolvedValueOnce({ status: "failed" as const, remote: "origin", timedOut: false })
      .mockResolvedValueOnce({ status: "succeeded" as const, remote: "origin", timedOut: false });

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: false,
      inspect: vi.fn(async () => state()),
      fetch,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result?.audit.fetchStatus).toBe("succeeded");
  });

  it("can use a stale local remote ref after fetch failure and records that fact", async () => {
    const ctx = context("tui", async (_title, options) => (
      options.find((option) => option.startsWith("Use existing"))
    ));

    await expect(resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: false,
      inspect: vi.fn(async () => state()),
      fetch: vi.fn(async () => ({ status: "failed" as const, remote: "origin", timedOut: true })),
    })).resolves.toMatchObject({
      audit: {
        fetchStatus: "failed-used-local",
        attemptedRemotes: ["origin"],
      },
    });
    const result = await resolveReviewPreflight({
      ctx: context("tui", async (_title, options) => (
        options.find((option) => option.startsWith("Use existing"))
      )),
      target: { mode: "local" },
      targetExplicit: false,
      inspect: vi.fn(async () => state()),
      fetch: vi.fn(async () => ({ status: "failed" as const, remote: "origin", timedOut: false })),
    });
    expect(result?.audit.fetchedRemotes).toBeUndefined();
  });

  it("fetches remotes referenced through full remote-tracking ref spellings", async () => {
    const inspect = vi.fn(async () => state());
    const fetch = vi.fn(async (_root: string, remote: string) => ({
      status: "succeeded" as const,
      remote,
      timedOut: false,
    }));
    const result = await resolveReviewPreflight({
      ctx: context(),
      target: { mode: "base", baseRef: "refs/remotes/origin/main" },
      targetExplicit: true,
      inspect,
      fetch,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toBe("origin");
    expect(result?.guard.targetRefs).toEqual([
      { ref: "refs/remotes/origin/main", sha: "b".repeat(40) },
    ]);
  });

  it("asks which default branch to use when main and master both exist without remote HEAD", async () => {
    const ctx = context();
    const select = vi.mocked(ctx.ui.select);
    select.mockResolvedValue("Review committed + local changes from origin/master");
    const ambiguous = state({
      defaultBranch: undefined,
      defaultBranchRef: undefined,
      defaultBranchSha: undefined,
      defaultBranchCandidates: ["origin/main", "origin/master"],
      defaultBranchAmbiguous: true,
      relationAvailable: false,
      ahead: undefined,
      behind: undefined,
    });
    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: false,
      inspect: vi.fn(async () => ambiguous),
      fetch: vi.fn(async () => ({ status: "succeeded" as const, remote: "origin", timedOut: false })),
    });

    expect(select.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      "Review committed + local changes from origin/main",
      "Review committed + local changes from origin/master",
    ]));
    expect(result?.target).toEqual({ mode: "base", baseRef: "origin/master" });
    expect(result?.audit.selection).toBe("interactive");
  });

  it("keeps colliding truncated default-branch labels bound to their exact refs", async () => {
    const stem = `refs/remotes/origin/${"x".repeat(180)}`;
    const candidates = [`${stem}-main`, `${stem}-master`];
    const ctx = context("tui", async (_title, options) => {
      expect(new Set(options).size).toBe(options.length);
      expect(options[0]).toMatch(/^\[1\] Review committed \+ local changes/u);
      expect(options[1]).toMatch(/^\[2\] Review committed \+ local changes/u);
      return options[1];
    });
    const ambiguous = state({
      defaultBranch: undefined,
      defaultBranchRef: undefined,
      defaultBranchSha: undefined,
      defaultBranchCandidates: candidates,
      defaultBranchAmbiguous: true,
      relationAvailable: false,
      ahead: undefined,
      behind: undefined,
    });

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: false,
      inspect: vi.fn(async () => ambiguous),
      fetch: vi.fn(async () => ({ status: "succeeded" as const, remote: "origin", timedOut: false })),
    });

    expect(result?.target).toEqual({ mode: "base", baseRef: candidates[1] });
  });

  it("fails headless on fetch failure or an ambiguous repository", async () => {
    const headless = context("json");
    await expect(resolveReviewPreflight({
      ctx: headless,
      target: { mode: "local" },
      targetExplicit: false,
      inspect: vi.fn(async () => state()),
      fetch: vi.fn(async () => ({ status: "failed" as const, remote: "origin", timedOut: false })),
    })).rejects.toThrow("Automatic Git fetch failed");

    await expect(resolveReviewPreflight({
      ctx: headless,
      target: { mode: "local" },
      targetExplicit: false,
      inspect: vi.fn(async () => state({ branch: undefined, remotes: [], preferredRemote: undefined })),
      fetch: vi.fn(),
    })).rejects.toBeInstanceOf(ReviewCommandError);
  });

  it("asks for a remote only when upstream/origin selection is ambiguous", async () => {
    const initial = state({
      remotes: ["company", "fork"],
      upstreamRef: undefined,
      upstreamRemote: undefined,
      preferredRemote: undefined,
      remoteAmbiguous: true,
      defaultBranch: undefined,
      defaultBranchRef: undefined,
      relationAvailable: false,
      ahead: undefined,
      behind: undefined,
    });
    const selected = state({
      remotes: ["company", "fork"],
      upstreamRef: undefined,
      upstreamRemote: undefined,
      preferredRemote: "fork",
      defaultBranchRef: "fork/main",
    });
    const inspect = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(selected);
    const ctx = context("tui", async (_title, options) => (
      options.find((option) => option === "Use remote: fork")
    ));
    const fetch = vi.fn(async () => ({ status: "succeeded" as const, remote: "fork", timedOut: false }));

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: false,
      inspect,
      fetch,
    });

    expect(fetch).toHaveBeenCalledWith("/repo", "fork", expect.any(Object));
    expect(result).toMatchObject({
      target: { mode: "base", baseRef: "fork/main" },
      audit: { remote: "fork", fetchedRemotes: ["fork"] },
    });
  });

  it("keeps colliding truncated remote labels bound to their exact remotes", async () => {
    const stem = `remote-${"x".repeat(180)}`;
    const remotes = [`${stem}-one`, `${stem}-two`];
    const initial = state({
      remotes,
      upstreamRef: undefined,
      upstreamRemote: undefined,
      preferredRemote: undefined,
      remoteAmbiguous: true,
      defaultBranch: undefined,
      defaultBranchRef: undefined,
      relationAvailable: false,
      ahead: undefined,
      behind: undefined,
    });
    const selected = state({
      remotes,
      upstreamRef: undefined,
      upstreamRemote: undefined,
      preferredRemote: remotes[1],
      defaultBranchRef: `${remotes[1]}/main`,
    });
    const inspect = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(selected);
    const ctx = context("tui", async (_title, options) => {
      expect(new Set(options).size).toBe(options.length);
      expect(options[0]).toMatch(/^\[1\] Use remote:/u);
      expect(options[1]).toMatch(/^\[2\] Use remote:/u);
      return options[1];
    });
    const fetch = vi.fn(async () => ({
      status: "succeeded" as const,
      remote: remotes[1],
      timedOut: false,
    }));

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: false,
      inspect,
      fetch,
    });

    expect(fetch).toHaveBeenCalledWith("/repo", remotes[1], expect.any(Object));
    expect(result?.audit.remote).toBe(remotes[1]);
  });

  it("cancels before model selection when fetch failure is not accepted", async () => {
    const ctx = context("tui", async (_title, options) => (
      options.find((option) => option === "Cancel review")
    ));

    await expect(resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: false,
      inspect: vi.fn(async () => state()),
      fetch: vi.fn(async () => ({ status: "failed" as const, remote: "origin", timedOut: false })),
    })).resolves.toBeUndefined();
  });

  it("treats --local as an explicit offline target and skips fetch and target UI", async () => {
    const ctx = context();
    const fetch = vi.fn();

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: true,
      inspect: vi.fn(async () => state()),
      fetch,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      target: { mode: "local" },
      audit: { selection: "explicit", fetchStatus: "not-needed" },
    });
  });

  it("asks whether dirty whole-target work should be included without committing", async () => {
    const ctx = context("tui", async (title, options) => {
      expect(title).toContain("can freeze and include them without creating a commit");
      expect(options).toEqual([
        "Continue and include uncommitted changes",
        "Cancel review and commit changes first",
      ]);
      return options[0];
    });

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: true,
      inspect: vi.fn(async () => state({
        workingTree: { staged: true, unstaged: true, untracked: true, unmerged: false },
      })),
    });

    expect(result?.target).toEqual({ mode: "local" });
    expect(ctx.ui.select).toHaveBeenCalledWith(
      expect.stringContaining("staged, unstaged, untracked"),
      [
        "Continue and include uncommitted changes",
        "Cancel review and commit changes first",
      ],
      undefined,
    );
  });

  it("lets a committed-only range stop so dirty work can be committed first", async () => {
    const ctx = context("tui", async (_title, options) => (
      options.find((option) => option === "Cancel review and commit changes first")
    ));

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "range", fromRef: "b".repeat(40), toRef: "a".repeat(40) },
      targetExplicit: true,
      inspect: vi.fn(async () => state({
        remotes: [],
        preferredRemote: undefined,
        workingTree: { staged: false, unstaged: true, untracked: false, unmerged: false },
      })),
    });

    expect(result).toBeUndefined();
    expect(ctx.ui.select).toHaveBeenCalledWith(
      expect.stringContaining("commit range contains committed snapshots only"),
      [
        "Continue with committed range only",
        "Cancel review and commit changes first",
      ],
      undefined,
    );
  });

  it("fetches remotes referenced by an explicit base target", async () => {
    const fetch = vi.fn(async () => ({ status: "succeeded" as const, remote: "origin", timedOut: false }));

    const result = await resolveReviewPreflight({
      ctx: context(),
      target: { mode: "base", baseRef: "origin/main" },
      targetExplicit: true,
      inspect: vi.fn(async () => state()),
      fetch,
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      target: { mode: "base", baseRef: "origin/main" },
      audit: { selection: "explicit", fetchStatus: "succeeded", fetchedRemotes: ["origin"] },
    });
  });

  it("asks TUI users before whole-target review above the recommended threshold", async () => {
    const ctx = context("tui", async (_title, options) => (
      options.find((option) => option.includes("whole target"))
    ));
    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: true,
      inspect: vi.fn(async () => state()),
      fingerprintTarget: fingerprintWithSize(300 * 1024, 6_000),
    });

    expect(result).toMatchObject({
      largeInput: true,
      inputSize: { bytes: 300 * 1024, lines: 6_000 },
      audit: { inputBytes: 300 * 1024, inputLines: 6_000, largeInput: true },
    });
    expect(result?.summary).toContain("Large input approved");
    expect(ctx.ui.select).toHaveBeenCalledWith(
      expect.stringContaining("Large targets use more reviewer turns"),
      expect.arrayContaining(["Review the whole target", "Cancel review"]),
      undefined,
    );
  });

  it("cancels a TUI large-target decision without producing a preflight", async () => {
    const ctx = context("tui", async (_title, options) => (
      options.find((option) => option === "Cancel review")
    ));
    await expect(resolveReviewPreflight({
      ctx,
      target: { mode: "local" },
      targetExplicit: true,
      inspect: vi.fn(async () => state()),
      fingerprintTarget: fingerprintWithSize(300 * 1024, 6_000),
    })).resolves.toBeUndefined();
  });

  it("requires --allow-large headlessly and accepts it explicitly", async () => {
    const base = {
      ctx: context("json"),
      target: { mode: "local" as const },
      targetExplicit: true,
      inspect: vi.fn(async () => state()),
      fingerprintTarget: fingerprintWithSize(300 * 1024, 100),
    };
    const error = await resolveReviewPreflight(base).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReviewCommandError);
    expect((error as Error).message).toContain("307200 bytes > 204800 bytes");
    expect((error as Error).message).not.toContain("100 lines");
    expect((error as Error).message).toContain("Pass --allow-large");
    await expect(resolveReviewPreflight({ ...base, allowLarge: true })).resolves.toMatchObject({
      largeInput: true,
    });
  });

  it("continues the same TUI run with an exact soft-bounded range choice", async () => {
    const fromSha = "b".repeat(40);
    const toSha = "a".repeat(40);
    const ctx = context("tui", async (_title, options) => (
      options.find((option) => option === "Review by commit plan") ??
      options.find((option) => option.startsWith("Range 1/1"))
    ));
    const suggestRanges = vi.fn(async () => ({
      commands: [`--range ${fromSha}..${toSha}`],
      note: "Run other ranges separately.",
    }));
    const fingerprintTarget = vi.fn(async ({ cwd, target }: {
      cwd: string;
      target: ReviewTargetRequest;
    }) => {
      const large = target.mode !== "range";
      return {
        root: cwd,
        headSha: "a".repeat(40),
        statusSha256: "c".repeat(64),
        targetSha256: large ? "d".repeat(64) : "f".repeat(64),
        inputSize: large ? { bytes: 300 * 1024, lines: 6_000 } : { bytes: 8_192, lines: 120 },
        inputSha256: large ? "e".repeat(64) : "9".repeat(64),
        resolvedTarget: target.mode === "range"
          ? {
              mode: "range" as const,
              fromRef: target.fromRef,
              toRef: target.toRef,
              fromSha: target.fromRef,
              toSha: target.toRef,
              currentHeadSha: "a".repeat(40),
              currentBranch: "feature/review",
              checkoutEstimate: { entries: 1, logicalBytes: "1" },
            }
          : {
              mode: "base" as const,
              baseRef: "HEAD~1",
              baseSha: "b".repeat(40),
              headSha: "a".repeat(40),
            },
        targetRefs: target.mode === "range"
          ? [{ ref: target.fromRef, sha: target.fromRef }, { ref: target.toRef, sha: target.toRef }]
          : [{ ref: "HEAD~1", sha: "b".repeat(40) }],
      };
    });

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "base", baseRef: "HEAD~1" },
      targetExplicit: true,
      inspect: vi.fn(async () => state()),
      fingerprintTarget,
      suggestRanges,
    });

    expect(result).toMatchObject({
      target: { mode: "range", fromRef: fromSha, toRef: toSha },
      audit: {
        selection: "interactive",
        inputBytes: 8_192,
        inputLines: 120,
      },
      inputSize: { bytes: 8_192, lines: 120 },
      largeInput: false,
    });
    expect(result?.summary).toContain(`${fromSha.slice(0, 12)}`);
    expect(fingerprintTarget).toHaveBeenCalledTimes(2);
    expect(suggestRanges).toHaveBeenCalledWith(expect.objectContaining({
      maxBytes: 200 * 1024,
      maxLines: 5_000,
    }));
    expect(ctx.ui.notify).toHaveBeenCalledWith("Run other ranges separately.", "warning");
  });

  it("shows a commit-aware coverage plan and requires confirmation for a large single commit", async () => {
    const baseSha = "b".repeat(40);
    const largeSha = "1".repeat(40);
    const boundedSha = "a".repeat(40);
    let interaction = 0;
    const seen: Array<{ title: string; options: string[] }> = [];
    const ctx = context("tui", async (title, options) => {
      seen.push({ title, options });
      interaction++;
      if (interaction === 1) {
        return options.find((option) => option === "Review by commit plan");
      }
      if (interaction === 2) {
        return options.find((option) => option.startsWith("⚠ 1/2"));
      }
      return options.find((option) => option === "Review this large commit");
    });
    const fingerprintTarget = vi.fn(async ({ cwd, target }: {
      cwd: string;
      target: ReviewTargetRequest;
    }) => ({
      root: cwd,
      headSha: "a".repeat(40),
      statusSha256: "c".repeat(64),
      targetSha256: "d".repeat(64),
      inputSize: target.mode === "range" && target.toRef === largeSha
        ? { bytes: 230 * 1024, lines: 5_600 }
        : { bytes: 300 * 1024, lines: 6_000 },
      inputSha256: "e".repeat(64),
      resolvedTarget: target.mode === "range"
        ? {
            mode: "range" as const,
            fromRef: target.fromRef,
            toRef: target.toRef,
            fromSha: target.fromRef,
            toSha: target.toRef,
            currentHeadSha: "a".repeat(40),
            currentBranch: "feature/review",
            checkoutEstimate: { entries: 2, logicalBytes: "2" },
          }
        : {
            mode: "base" as const,
            baseRef: "HEAD~2",
            baseSha,
            headSha: "a".repeat(40),
          },
      targetRefs: target.mode === "range"
        ? [{ ref: target.fromRef, sha: target.fromRef }, { ref: target.toRef, sha: target.toRef }]
        : [{ ref: "HEAD~2", sha: baseSha }],
    }));

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "base", baseRef: "HEAD~2" },
      targetExplicit: true,
      inspect: vi.fn(async () => state()),
      fingerprintTarget,
      suggestRanges: vi.fn(async () => ({
        commands: [`--range ${largeSha}..${boundedSha}`],
        plan: {
          targetCommitCount: 2,
          analyzedCommitCount: 2,
          emptyCommitCount: 0,
          requiresSeparateLocalReview: false,
          items: [
            {
              kind: "large-single" as const,
              fromSha: baseSha,
              toSha: largeSha,
              commitCount: 1,
              firstCommit: {
                sha: largeSha,
                subject: "implement trusted companion lifecycle",
                ordinal: 1,
              },
              lastCommit: {
                sha: largeSha,
                subject: "implement trusted companion lifecycle",
                ordinal: 1,
              },
              inputSize: { bytes: 230 * 1024, lines: 5_600 },
              changedFileCount: 17,
            },
            {
              kind: "bounded" as const,
              fromSha: largeSha,
              toSha: boundedSha,
              commitCount: 1,
              firstCommit: {
                sha: boundedSha,
                subject: "finalize release surface",
                ordinal: 2,
              },
              lastCommit: {
                sha: boundedSha,
                subject: "finalize release surface",
                ordinal: 2,
              },
              inputSize: { bytes: 80 * 1024, lines: 900 },
              changedFileCount: 4,
            },
          ],
        },
      })),
    });

    expect(seen[1]?.title).toContain("2/2 commits accounted for");
    expect(seen[1]?.title).toContain("1 large commit needs approval");
    expect(seen[1]?.options).toEqual(expect.arrayContaining([
      expect.stringMatching(
        /^⚠ 1\/2 · approval required · 230\.0 KiB \/ 5,600 lines · 17 files · implement trusted companion lifecycle · 1111111$/u,
      ),
      expect.stringMatching(
        /^✓ 2\/2 · bounded · 80\.0 KiB \/ 900 lines · 4 files · finalize release surface · aaaaaaa$/u,
      ),
    ]));
    expect(seen[2]?.title).toContain("implement trusted companion lifecycle");
    expect(seen[2]?.title).toContain("230.0 KiB / 5,600 lines · 17 files");
    expect(result).toMatchObject({
      target: { mode: "range", fromRef: baseSha, toRef: largeSha },
      audit: { selection: "interactive", largeInput: true },
      inputSize: { bytes: 230 * 1024, lines: 5_600 },
      largeInput: true,
    });
  });

  it("sanitizes and truncates untrusted commit subjects without changing exact range identity", async () => {
    const fromSha = "b".repeat(40);
    const toSha = "a".repeat(40);
    const maliciousSubject = `release\u001b[31m\u202e${"😀".repeat(90)}`;
    let interaction = 0;
    let planOptions: string[] = [];
    const ctx = context("tui", async (_title, options) => {
      interaction++;
      if (interaction === 1) {
        return options.find((option) => option === "Review by commit plan");
      }
      planOptions = options;
      return options.find((option) => option.startsWith("✓ 1/1"));
    });
    const fingerprintTarget = vi.fn(async ({ cwd, target }: {
      cwd: string;
      target: ReviewTargetRequest;
    }) => ({
      root: cwd,
      headSha: "a".repeat(40),
      statusSha256: "c".repeat(64),
      targetSha256: "d".repeat(64),
      inputSize: target.mode === "range"
        ? { bytes: 1_024, lines: 20 }
        : { bytes: 300 * 1024, lines: 6_000 },
      inputSha256: "e".repeat(64),
      resolvedTarget: target.mode === "range"
        ? {
            mode: "range" as const,
            fromRef: target.fromRef,
            toRef: target.toRef,
            fromSha: target.fromRef,
            toSha: target.toRef,
            currentHeadSha: "a".repeat(40),
            currentBranch: "feature/review",
            checkoutEstimate: { entries: 1, logicalBytes: "1" },
          }
        : {
            mode: "base" as const,
            baseRef: "HEAD~1",
            baseSha: fromSha,
            headSha: "a".repeat(40),
          },
      targetRefs: target.mode === "range"
        ? [{ ref: target.fromRef, sha: target.fromRef }, { ref: target.toRef, sha: target.toRef }]
        : [{ ref: "HEAD~1", sha: fromSha }],
    }));

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "base", baseRef: "HEAD~1" },
      targetExplicit: true,
      inspect: vi.fn(async () => state()),
      fingerprintTarget,
      suggestRanges: vi.fn(async () => ({
        commands: [`--range ${fromSha}..${toSha}`],
        plan: {
          targetCommitCount: 1,
          analyzedCommitCount: 1,
          emptyCommitCount: 0,
          requiresSeparateLocalReview: false,
          items: [{
            kind: "bounded" as const,
            fromSha,
            toSha,
            commitCount: 1,
            firstCommit: { sha: toSha, subject: maliciousSubject, ordinal: 1 },
            lastCommit: { sha: toSha, subject: maliciousSubject, ordinal: 1 },
            inputSize: { bytes: 1_024, lines: 20 },
            changedFileCount: 1,
          }],
        },
      })),
    });

    const label = planOptions.find((option) => option.startsWith("✓ 1/1"));
    expect(label).toBeDefined();
    expect(label).not.toContain("\u001b");
    expect(label).not.toContain("\u202e");
    expect(label).toContain("�");
    expect(label).toContain("…");
    expect(label).toMatch(/aaaaaaa$/u);
    expect(result?.target).toEqual({ mode: "range", fromRef: fromSha, toRef: toSha });
  });

  it("keeps colliding range labels bound to the selected exact SHA pair", async () => {
    const prefix = "a".repeat(12);
    const first = {
      from: `${prefix}${"1".repeat(28)}`,
      to: `${prefix}${"2".repeat(28)}`,
    };
    const second = {
      from: `${prefix}${"3".repeat(28)}`,
      to: `${prefix}${"4".repeat(28)}`,
    };
    const ctx = context("tui", async (_title, options) => (
      options.find((option) => option === "Review by commit plan") ??
      options.find((option) => option.startsWith("Range 2/2"))
    ));
    const fingerprintTarget = vi.fn(async ({ cwd, target }: {
      cwd: string;
      target: ReviewTargetRequest;
    }) => ({
      root: cwd,
      headSha: "a".repeat(40),
      statusSha256: "c".repeat(64),
      targetSha256: "d".repeat(64),
      inputSize: target.mode === "range"
        ? { bytes: 1_024, lines: 20 }
        : { bytes: 300 * 1024, lines: 6_000 },
      inputSha256: "e".repeat(64),
      resolvedTarget: target.mode === "range"
        ? {
            mode: "range" as const,
            fromRef: target.fromRef,
            toRef: target.toRef,
            fromSha: target.fromRef,
            toSha: target.toRef,
            currentHeadSha: "a".repeat(40),
            currentBranch: "feature/review",
            checkoutEstimate: { entries: 1, logicalBytes: "1" },
          }
        : {
            mode: "base" as const,
            baseRef: "HEAD~2",
            baseSha: "b".repeat(40),
            headSha: "a".repeat(40),
          },
      targetRefs: target.mode === "range"
        ? [{ ref: target.fromRef, sha: target.fromRef }, { ref: target.toRef, sha: target.toRef }]
        : [{ ref: "HEAD~2", sha: "b".repeat(40) }],
    }));

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "base", baseRef: "HEAD~2" },
      targetExplicit: true,
      inspect: vi.fn(async () => state()),
      fingerprintTarget,
      suggestRanges: vi.fn(async () => ({
        commands: [
          `--range ${first.from}..${first.to}`,
          `--range ${second.from}..${second.to}`,
        ],
      })),
    });

    expect(result?.target).toEqual({
      mode: "range",
      fromRef: second.from,
      toRef: second.to,
    });
  });

  it("offers bounded ranges for an absolute-limit failure and revalidates the selected target", async () => {
    const fromSha = "b".repeat(40);
    const toSha = "a".repeat(40);
    const hardFailure = new OversizedReviewInputError({
      bytes: { limit: 1024 * 1024, actual: 2 * 1024 * 1024 },
    }).addRangeSuggestions(
      [`--range ${fromSha}..${toSha}`],
      "The whole target cannot be reviewed safely.",
    );
    const fingerprintTarget = vi.fn()
      .mockRejectedValueOnce(hardFailure)
      .mockResolvedValueOnce({
        root: "/repo",
        headSha: "a".repeat(40),
        statusSha256: "c".repeat(64),
        targetSha256: "f".repeat(64),
        inputSize: { bytes: 16_384, lines: 200 },
        inputSha256: "9".repeat(64),
        resolvedTarget: {
          mode: "range" as const,
          fromRef: fromSha,
          toRef: toSha,
          fromSha,
          toSha,
          currentHeadSha: "a".repeat(40),
          currentBranch: "feature/review",
          checkoutEstimate: { entries: 1, logicalBytes: "1" },
        },
        targetRefs: [{ ref: fromSha, sha: fromSha }, { ref: toSha, sha: toSha }],
      });
    const ctx = context("tui", async (_title, options) => (
      options.find((option) => option.startsWith("Range 1/1"))
    ));

    const result = await resolveReviewPreflight({
      ctx,
      target: { mode: "base", baseRef: "HEAD~5" },
      targetExplicit: true,
      inspect: vi.fn(async () => state()),
      fingerprintTarget,
    });

    expect(result).toMatchObject({
      target: { mode: "range", fromRef: fromSha, toRef: toSha },
      audit: { selection: "interactive" },
      largeInput: false,
    });
    expect(fingerprintTarget).toHaveBeenCalledTimes(2);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("absolute frozen-input limit"),
      "warning",
    );
  });

  it("keeps an absolute-limit commit visible but refuses to continue it", async () => {
    const fromSha = "b".repeat(40);
    const toSha = "a".repeat(40);
    let interaction = 0;
    const ctx = context("tui", async (_title, options) => {
      interaction++;
      if (interaction === 1) return options.find((option) => option.startsWith("✗ 1/1"));
      return options.find((option) => option === "Cancel review");
    });
    const hardFailure = new OversizedReviewInputError({
      bytes: { limit: 1024 * 1024, actual: 2 * 1024 * 1024 },
    }).addRangeSuggestions([], undefined, {
      targetCommitCount: 1,
      analyzedCommitCount: 1,
      emptyCommitCount: 0,
      requiresSeparateLocalReview: false,
      items: [{
        kind: "too-large-single",
        fromSha,
        toSha,
        commitCount: 1,
        firstCommit: { sha: toSha, subject: "generated bundle", ordinal: 1 },
        lastCommit: { sha: toSha, subject: "generated bundle", ordinal: 1 },
      }],
    });
    const fingerprintTarget = vi.fn(async () => { throw hardFailure; });

    await expect(resolveReviewPreflight({
      ctx,
      target: { mode: "base", baseRef: "HEAD~1" },
      targetExplicit: true,
      inspect: vi.fn(async () => state()),
      fingerprintTarget,
    })).resolves.toBeUndefined();

    expect(fingerprintTarget).toHaveBeenCalledOnce();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("generated bundle exceeds the absolute frozen-input limit"),
      "error",
    );
  });

  it("keeps malformed hard-limit suggestions fail-closed", async () => {
    const hardFailure = new OversizedReviewInputError({
      lines: { limit: 25_000, actual: 30_000 },
    }).addRangeSuggestions(["--range HEAD~1..HEAD"]);

    await expect(resolveReviewPreflight({
      ctx: context(),
      target: { mode: "base", baseRef: "HEAD~5" },
      targetExplicit: true,
      inspect: vi.fn(async () => state()),
      fingerprintTarget: vi.fn(async () => { throw hardFailure; }),
    })).rejects.toBe(hardFailure);
  });

  it("cancels from the second-level range picker before re-fingerprinting", async () => {
    let pick = 0;
    const ctx = context("tui", async (_title, options) => {
      pick++;
      return pick === 1
        ? options.find((option) => option === "Review by commit plan")
        : undefined;
    });
    const fingerprintTarget = fingerprintWithSize(300 * 1024, 6_000);

    await expect(resolveReviewPreflight({
      ctx,
      target: { mode: "base", baseRef: "HEAD~1" },
      targetExplicit: true,
      inspect: vi.fn(async () => state()),
      fingerprintTarget,
      suggestRanges: vi.fn(async () => ({
        commands: [`--range ${"b".repeat(40)}..${"a".repeat(40)}`],
      })),
    })).resolves.toBeUndefined();
    expect(fingerprintTarget).toHaveBeenCalledOnce();
  });

  it("returns from the range picker to whole-target approval without recomputing suggestions", async () => {
    let pick = 0;
    const ctx = context("tui", async (_title, options) => {
      pick++;
      if (pick === 1) return options.find((option) => option === "Review by commit plan");
      if (pick === 2) return options.find((option) => option.includes("Back to whole-target"));
      return options.find((option) => option === "Review the whole target");
    });
    const suggestRanges = vi.fn(async () => ({
      commands: [`--range ${"b".repeat(40)}..${"a".repeat(40)}`],
    }));

    await expect(resolveReviewPreflight({
      ctx,
      target: { mode: "base", baseRef: "HEAD~1" },
      targetExplicit: true,
      inspect: vi.fn(async () => state()),
      fingerprintTarget: fingerprintWithSize(300 * 1024, 6_000),
      suggestRanges,
    })).resolves.toMatchObject({ largeInput: true });
    expect(suggestRanges).toHaveBeenCalledOnce();
  });

  it("binds picker-time state and rejects branch, status, or target-ref drift", async () => {
    const stable = state();
    const preflight = await resolveReviewPreflight({
      ctx: context(),
      target: { mode: "local" },
      targetExplicit: false,
      inspect: vi.fn(async () => stable),
      fetch: vi.fn(async () => ({ status: "succeeded" as const, remote: "origin", timedOut: false })),
    });
    expect(preflight).toBeDefined();

    await expect(revalidateReviewPreflight(preflight!, {
      inspect: vi.fn(async () => stable),
    })).resolves.toBe(true);
    await expect(revalidateReviewPreflight(preflight!, {
      inspect: vi.fn(async () => state({ statusSha256: "d".repeat(64) })),
    })).resolves.toBe(false);
    await expect(revalidateReviewPreflight(preflight!, {
      inspect: vi.fn(async () => state({ branch: "other-feature" })),
    })).resolves.toBe(false);
    await expect(revalidateReviewPreflight(preflight!, {
      inspect: vi.fn(async () => state({ defaultBranchSha: "e".repeat(40) })),
    })).resolves.toBe(false);
    vi.mocked(fingerprintReviewTarget).mockResolvedValueOnce({
      root: "/repo",
      headSha: "a".repeat(40),
      statusSha256: "c".repeat(64),
      targetSha256: "e".repeat(64),
      inputSize: { bytes: 1024, lines: 20 },
      inputSha256: "e".repeat(64),
      resolvedTarget: {
        mode: "base", baseRef: "origin/main", baseSha: "b".repeat(40), headSha: "a".repeat(40),
      },
      targetRefs: [{ ref: "origin/main", sha: "b".repeat(40) }],
    });
    await expect(revalidateReviewPreflight(preflight!, {
      inspect: vi.fn(async () => stable),
    })).resolves.toBe(false);
    vi.mocked(fingerprintReviewTarget).mockResolvedValueOnce({
      root: "/repo",
      headSha: "a".repeat(40),
      statusSha256: "c".repeat(64),
      targetSha256: "e".repeat(64),
      inputSize: { bytes: 1024, lines: 20 },
      inputSha256: "e".repeat(64),
      resolvedTarget: {
        mode: "base", baseRef: "origin/main", baseSha: "b".repeat(40), headSha: "a".repeat(40),
      },
      targetRefs: [{ ref: "origin/main", sha: "b".repeat(40) }],
    });
    const frozenTarget = {
      mode: "base" as const,
      description: "guarded base",
      root: "/repo",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      statusSha256: "c".repeat(64),
      targetSha256: "d".repeat(64),
      changedFiles: ["file.ts"],
    };
    await expect(revalidateReviewPreflight(preflight!, {
      inspect: vi.fn(async () => stable),
      frozenTarget,
    })).resolves.toBe(false);
    vi.mocked(fingerprintReviewTarget).mockResolvedValueOnce({
      root: "/repo",
      headSha: "a".repeat(40),
      statusSha256: "c".repeat(64),
      targetSha256: "d".repeat(64),
      inputSize: { bytes: 1024, lines: 20 },
      inputSha256: "e".repeat(64),
      resolvedTarget: {
        mode: "base", baseRef: "origin/main", baseSha: "b".repeat(40), headSha: "a".repeat(40),
      },
      targetRefs: [{ ref: "origin/main", sha: "f".repeat(40) }],
    });
    await expect(revalidateReviewPreflight(preflight!, {
      inspect: vi.fn(async () => stable),
      frozenTarget,
    })).resolves.toBe(false);
    await expect(revalidateReviewPreflight(preflight!, {
      inspect: vi.fn(async () => { throw new ReviewInputError("ref disappeared"); }),
    })).resolves.toBe(false);
  });

  it("stops before reviewer selection when the refreshed target has no changes", async () => {
    await expect(resolveReviewPreflight({
      ctx: context(),
      target: { mode: "local" },
      targetExplicit: false,
      inspect: vi.fn(async () => state({
        branch: "main",
        upstreamRef: "origin/main",
        ahead: 0,
        behind: 0,
        workingTree: { staged: false, unstaged: false, untracked: false, unmerged: false },
      })),
      fetch: vi.fn(async () => ({ status: "succeeded" as const, remote: "origin", timedOut: false })),
    })).rejects.toBeInstanceOf(EmptyReviewInputError);
  });
});
