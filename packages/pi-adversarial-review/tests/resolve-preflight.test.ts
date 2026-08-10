import { describe, expect, it, vi } from "vitest";
import type { ReviewTargetRequest } from "../src/types.ts";

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
import { EmptyReviewInputError, ReviewInputError } from "../src/input/errors.ts";
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
    workingTree: { staged: false, unstaged: true, untracked: false, unmerged: false },
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

  it("infers local target on synchronized default branch after fetch", async () => {
    const ctx = context();
    const inspect = vi.fn(async () => state({
      branch: "main", upstreamRef: "origin/main", ahead: 0, behind: 0,
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

  it("returns soft-bounded target replacements when TUI chooses ranges", async () => {
    const ctx = context("tui", async (_title, options) => (
      options.find((option) => option.includes("range suggestions"))
    ));
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
    })).rejects.toThrow("Suggested smaller review ranges");
    expect(suggestRanges).toHaveBeenCalledWith(expect.objectContaining({
      maxBytes: 200 * 1024,
      maxLines: 5_000,
    }));
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
