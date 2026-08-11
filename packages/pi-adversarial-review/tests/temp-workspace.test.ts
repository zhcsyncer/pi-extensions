import { execFile } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertRangeCheckoutCapacity,
  createReviewTempWorkspace,
  scavengeStaleReviewTempWorkspaces,
} from "../src/input/temp-workspace.ts";

const exec = promisify(execFile);
const roots: string[] = [];

async function exists(target: string): Promise<boolean> {
  try { await access(target); return true; } catch { return false; }
}

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: root, encoding: "utf8" });
  return stdout.trim();
}

async function initRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-adversarial-worktree-test-"));
  roots.push(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "review@example.test");
  await git(root, "config", "user.name", "Review Test");
  await writeFile(path.join(root, "value.txt"), "committed\n");
  await git(root, "add", "value.txt");
  await git(root, "commit", "-qm", "base");
  return root;
}

async function quarantineRunAsDeadScavenger(
  tempRoot: string,
  runDir: string,
  ownerPid: number,
): Promise<string> {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  const quarantine = await mkdtemp(path.join(tempRoot, `pi-adversarial-review-scavenge-${uid}-`));
  await chmod(quarantine, 0o700);
  await writeFile(
    path.join(quarantine, "scavenge-owner.json"),
    `${JSON.stringify({ version: 1, ownerPid })}\n`,
    { mode: 0o600 },
  );
  await chmod(path.join(quarantine, "scavenge-owner.json"), 0o600);
  await rename(runDir, path.join(quarantine, path.basename(runDir)));
  return quarantine;
}

function fakeStatfs(available: bigint) {
  return vi.fn(async () => ({ bavail: available, bsize: 1n })) as any;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("range checkout capacity", () => {
  it("accepts exact count, byte, and free-space boundaries", async () => {
    await expect(assertRangeCheckoutCapacity({
      tempPath: tmpdir(),
      estimate: { entries: 10, logicalBytes: "100" },
      dependencies: {
        policy: {
          maxEntries: 10,
          maxLogicalBytes: 100n,
          minFreeBytes: 50n,
          freeSpaceMultiplier: 2n,
        },
        statfs: fakeStatfs(250n),
      },
    })).resolves.toEqual({ availableBytes: 250n, requiredBytes: 250n });
  });

  it("checks a deterministic common-Git admin/index reserve separately", async () => {
    const values = [250n, 16n * 1024n * 1024n + 10n * 256n - 1n];
    const measured = vi.fn(async () => ({ bavail: values.shift()!, bsize: 1n })) as any;
    await expect(assertRangeCheckoutCapacity({
      tempPath: tmpdir(),
      commonGitPath: tmpdir(),
      estimate: { entries: 10, logicalBytes: "100" },
      dependencies: {
        policy: {
          maxEntries: 10,
          maxLogicalBytes: 100n,
          minFreeBytes: 50n,
          freeSpaceMultiplier: 2n,
        },
        statfs: measured,
        filesystemIdentity: vi.fn()
          .mockResolvedValueOnce("checkout-device")
          .mockResolvedValueOnce("common-git-device"),
      },
    })).rejects.toThrow("Common Git filesystem free-space requirement not met");
    expect(measured).toHaveBeenCalledTimes(2);
  });

  it("combines checkout and common-Git reserves on one filesystem at the exact boundary", async () => {
    const commonRequired = 16n * 1024n * 1024n + 10n * 256n;
    const checkoutRequired = 50n + 100n * 2n;
    const identity = vi.fn(async () => "shared-device");
    await expect(assertRangeCheckoutCapacity({
      tempPath: tmpdir(),
      commonGitPath: tmpdir(),
      estimate: { entries: 10, logicalBytes: "100" },
      dependencies: {
        policy: {
          maxEntries: 10,
          maxLogicalBytes: 100n,
          minFreeBytes: 50n,
          freeSpaceMultiplier: 2n,
        },
        statfs: fakeStatfs(checkoutRequired + commonRequired),
        filesystemIdentity: identity,
      },
    })).resolves.toEqual({
      availableBytes: checkoutRequired + commonRequired,
      requiredBytes: checkoutRequired + commonRequired,
    });
    expect(identity).toHaveBeenCalledTimes(2);
  });

  it("rejects one byte below the combined shared-filesystem boundary", async () => {
    const required = 50n + 100n * 2n + 16n * 1024n * 1024n + 10n * 256n;
    await expect(assertRangeCheckoutCapacity({
      tempPath: tmpdir(),
      commonGitPath: tmpdir(),
      estimate: { entries: 10, logicalBytes: "100" },
      dependencies: {
        policy: {
          maxEntries: 10,
          maxLogicalBytes: 100n,
          minFreeBytes: 50n,
          freeSpaceMultiplier: 2n,
        },
        statfs: fakeStatfs(required - 1n),
        filesystemIdentity: async () => "shared-device",
      },
    })).rejects.toThrow(`available=${required - 1n}, required=${required}`);
  });

  it("reports measured limits and fails before worktree add", async () => {
    const root = await initRepo();
    const sha = await git(root, "rev-parse", "HEAD");
    const registrations = await git(root, "worktree", "list", "--porcelain");
    const workspace = await createReviewTempWorkspace("capacity");
    roots.push(workspace.runDir);

    await expect(workspace.createRangeWorktree({
      root,
      toSha: sha,
      estimate: { entries: 11, logicalBytes: "100" },
      dependencies: {
        policy: { maxEntries: 10, maxLogicalBytes: 100n, minFreeBytes: 50n, freeSpaceMultiplier: 2n },
        statfs: fakeStatfs(200n),
      },
    })).rejects.toThrow("measured=11, allowed=10");
    expect(await git(root, "worktree", "list", "--porcelain")).toBe(registrations);

    await expect(workspace.createRangeWorktree({
      root,
      toSha: sha,
      estimate: { entries: 10, logicalBytes: "101" },
      dependencies: {
        policy: { maxEntries: 10, maxLogicalBytes: 100n, minFreeBytes: 50n, freeSpaceMultiplier: 2n },
        statfs: fakeStatfs(1_000n),
      },
    })).rejects.toThrow("measured=101, allowed=100");
    await expect(workspace.createRangeWorktree({
      root,
      toSha: sha,
      estimate: { entries: 10, logicalBytes: "100" },
      dependencies: {
        policy: { maxEntries: 10, maxLogicalBytes: 100n, minFreeBytes: 50n, freeSpaceMultiplier: 2n },
        statfs: fakeStatfs(249n),
        filesystemIdentity: vi.fn()
          .mockResolvedValueOnce("checkout-device")
          .mockResolvedValueOnce("common-git-device"),
      },
    })).rejects.toThrow("available=249, required=250");
    expect(await git(root, "worktree", "list", "--porcelain")).toBe(registrations);
    await workspace.cleanup();
  });
});

describe("linked worktree failure cleanup", () => {
  async function gitWrapper(realGit: string, body: string): Promise<string> {
    const bin = await mkdtemp(path.join(tmpdir(), "pi-adversarial-git-wrapper-"));
    roots.push(bin);
    const wrapper = path.join(bin, "git");
    await writeFile(wrapper, `#!/bin/sh\n${body}\nexec ${JSON.stringify(realGit)} "$@"\n`);
    await chmod(wrapper, 0o700);
    return bin;
  }

  it("cleans an add failure that created no registration", async () => {
    const root = await initRepo();
    const sha = await git(root, "rev-parse", "HEAD");
    const before = await git(root, "worktree", "list", "--porcelain");
    const workspace = await createReviewTempWorkspace("add-failure");
    roots.push(workspace.runDir);
    const realGit = (await exec("which", ["git"], { encoding: "utf8" })).stdout.trim();
    const bin = await gitWrapper(realGit, 'if [ "$1" = worktree ] && [ "$2" = add ]; then exit 42; fi');
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    try {
      await expect(workspace.createRangeWorktree({
        root, toSha: sha, estimate: { entries: 1, logicalBytes: "10" },
      })).rejects.toThrow("Create detached review worktree failed");
    } finally {
      process.env.PATH = previousPath;
    }
    await workspace.cleanup();
    expect(await git(root, "worktree", "list", "--porcelain")).toBe(before);
  });

  it("recovers when real worktree add succeeds but its wrapper exits 42", async () => {
    const root = await initRepo();
    const sha = await git(root, "rev-parse", "HEAD");
    const before = await git(root, "worktree", "list", "--porcelain");
    const workspace = await createReviewTempWorkspace("post-add-wrapper-failure");
    roots.push(workspace.runDir);
    const realGit = (await exec("which", ["git"], { encoding: "utf8" })).stdout.trim();
    const bin = await gitWrapper(
      realGit,
      `if [ "$1" = worktree ] && [ "$2" = add ]; then ${JSON.stringify(realGit)} "$@"; exit 42; fi`,
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    try {
      await expect(workspace.createRangeWorktree({
        root, toSha: sha, estimate: { entries: 1, logicalBytes: "10" },
      })).rejects.toThrow("Create detached review worktree failed");
      expect(await exists(workspace.worktreeDir)).toBe(true);
      expect(await readFile(path.join(workspace.runDir, "worktree-owner.json"), "utf8"))
        .toContain('"state":"pending"');
    } finally {
      process.env.PATH = previousPath;
    }
    await workspace.cleanup();
    expect(await exists(workspace.runDir)).toBe(false);
    expect(await git(root, "worktree", "list", "--porcelain")).toBe(before);
  });

  it("removes the exact owned registration after reset failure or cancellation", async () => {
    for (const cancellation of [false, true]) {
      const root = await initRepo();
      const sha = await git(root, "rev-parse", "HEAD");
      const before = await git(root, "worktree", "list", "--porcelain");
      const workspace = await createReviewTempWorkspace(cancellation ? "reset-cancel" : "reset-failure");
      roots.push(workspace.runDir);
      const realGit = (await exec("which", ["git"], { encoding: "utf8" })).stdout.trim();
      const marker = path.join(root, ".git", "reset-started");
      const resetBody = cancellation
        ? `if [ "$1" = reset ]; then touch ${JSON.stringify(marker)}; trap '' TERM; while :; do sleep 1; done; fi`
        : 'if [ "$1" = reset ]; then exit 43; fi';
      const bin = await gitWrapper(realGit, resetBody);
      const previousPath = process.env.PATH;
      process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
      const controller = new AbortController();
      try {
        const creating = workspace.createRangeWorktree({
          root,
          toSha: sha,
          estimate: { entries: 1, logicalBytes: "10" },
          ...(cancellation ? { signal: controller.signal } : {}),
        });
        if (cancellation) {
          await vi.waitFor(async () => expect(await exists(marker)).toBe(true));
          controller.abort(new Error("cancel reset"));
          await expect(creating).rejects.toThrow("cancel reset");
        } else {
          await expect(creating).rejects.toThrow("Populate detached review worktree failed");
        }
      } finally {
        process.env.PATH = previousPath;
      }
      await workspace.cleanup();
      await workspace.cleanup();
      expect(await git(root, "worktree", "list", "--porcelain")).toBe(before);
    }
  });

  it("stops checkout at the live free-space floor without leaking a registration", async () => {
    const root = await initRepo();
    const sha = await git(root, "rev-parse", "HEAD");
    const before = await git(root, "worktree", "list", "--porcelain");
    const workspace = await createReviewTempWorkspace("live-free-floor");
    roots.push(workspace.runDir);
    const realGit = (await exec("which", ["git"], { encoding: "utf8" })).stdout.trim();
    const started = path.join(root, ".git", "reset-started");
    const bin = await gitWrapper(
      realGit,
      `if [ "$1" = reset ]; then touch ${JSON.stringify(started)}; trap '' TERM; while :; do sleep 1; done; fi`,
    );
    const measurements = [100_000_000n, 100_000_000n, 100_000_000n, 0n];
    const measured = vi.fn(async () => ({ bavail: measurements.shift() ?? 0n, bsize: 1n })) as any;
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    try {
      await expect(workspace.createRangeWorktree({
        root,
        toSha: sha,
        estimate: { entries: 1, logicalBytes: "10" },
        dependencies: {
          policy: { maxEntries: 10, maxLogicalBytes: 100n, minFreeBytes: 50n, freeSpaceMultiplier: 2n },
          statfs: measured,
          checkoutPollMs: 5,
        },
      })).rejects.toThrow("Range checkout live free-space floor crossed");
      expect(await exists(started)).toBe(true);
    } finally {
      process.env.PATH = previousPath;
    }
    await workspace.cleanup();
    expect(await git(root, "worktree", "list", "--porcelain")).toBe(before);
  });

  it("awaits a delayed final free-space poll after reset exits and removes the registration", async () => {
    const root = await initRepo();
    const sha = await git(root, "rev-parse", "HEAD");
    const before = await git(root, "worktree", "list", "--porcelain");
    const initialPollDone = path.join(root, ".git", "initial-poll-done");
    const realGit = (await exec("which", ["git"], { encoding: "utf8" })).stdout.trim();
    const bin = await gitWrapper(
      realGit,
      `if [ "$1" = reset ]; then while [ ! -f ${JSON.stringify(initialPollDone)} ]; do sleep 0.01; done; exit 0; fi`,
    );
    let releaseFinal!: () => void;
    let finalStarted!: () => void;
    const finalGate = new Promise<void>((resolve) => { releaseFinal = resolve; });
    const sawFinal = new Promise<void>((resolve) => { finalStarted = resolve; });
    let calls = 0;
    const measured = vi.fn(async () => {
      calls++;
      if (calls === 1) return { bavail: 100_000_000n, bsize: 1n };
      if (calls === 2) {
        await writeFile(initialPollDone, "ready");
        return { bavail: 100_000_000n, bsize: 1n };
      }
      finalStarted();
      await finalGate;
      return { bavail: 49n, bsize: 1n };
    }) as any;
    const workspace = await createReviewTempWorkspace("delayed-final-poll");
    roots.push(workspace.runDir);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    try {
      const creating = workspace.createRangeWorktree({
        root,
        toSha: sha,
        estimate: { entries: 1, logicalBytes: "10" },
        dependencies: {
          policy: { maxEntries: 10, maxLogicalBytes: 100n, minFreeBytes: 50n, freeSpaceMultiplier: 2n },
          statfs: measured,
          checkoutPollMs: 60_000,
        },
      });
      await sawFinal;
      let settled = false;
      void creating.finally(() => { settled = true; }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      releaseFinal();
      await expect(creating).rejects.toThrow("Range checkout live free-space floor crossed");
    } finally {
      process.env.PATH = previousPath;
      releaseFinal();
    }
    await workspace.cleanup();
    expect(await git(root, "worktree", "list", "--porcelain")).toBe(before);
  });

  it("resolves the common Git directory when the reviewed root is itself linked", async () => {
    const root = await initRepo();
    const sha = await git(root, "rev-parse", "HEAD");
    const linkedRoot = await mkdtemp(path.join(tmpdir(), "pi-adversarial-user-linked-parent-"));
    await rm(linkedRoot, { recursive: true, force: true });
    roots.push(linkedRoot);
    await git(root, "worktree", "add", "--detach", linkedRoot, sha);
    const workspace = await createReviewTempWorkspace("linked-root");
    roots.push(workspace.runDir);
    const reviewerCwd = await workspace.createRangeWorktree({
      root: linkedRoot,
      toSha: sha,
      estimate: { entries: 1, logicalBytes: "10" },
    });
    expect(await git(reviewerCwd, "rev-parse", "--path-format=absolute", "--git-common-dir"))
      .toBe(await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    await workspace.cleanup();
    await git(root, "worktree", "remove", "--force", linkedRoot);
  });

  it("retains ownership metadata when worktree-first removal fails", async () => {
    const root = await initRepo();
    const sha = await git(root, "rev-parse", "HEAD");
    const workspace = await createReviewTempWorkspace("remove-failure");
    roots.push(workspace.runDir);
    await workspace.createRangeWorktree({
      root, toSha: sha, estimate: { entries: 1, logicalBytes: "10" },
    });
    const realGit = (await exec("which", ["git"], { encoding: "utf8" })).stdout.trim();
    const bin = await gitWrapper(
      realGit,
      'if [ "$1" = worktree ] && [ "$2" = remove ]; then exit 44; fi',
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    try {
      await expect(workspace.cleanup()).rejects.toThrow(
        "workspace and ownership manifest were retained",
      );
      expect(await exists(path.join(workspace.runDir, "worktree-owner.json"))).toBe(true);
      expect(await exists(workspace.worktreeDir)).toBe(true);
    } finally {
      process.env.PATH = previousPath;
    }
    await workspace.cleanup();
  });

  it("persists completed ownership before retrying run-directory deletion", async () => {
    const root = await initRepo();
    const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-adversarial-retry-root-"));
    roots.push(tempRoot);
    const sha = await git(root, "rev-parse", "HEAD");
    let removals = 0;
    const workspace = await createReviewTempWorkspace("retry-run-delete", {
      rootDir: tempRoot,
      dependencies: {
        removeTree: async (target) => {
          removals++;
          if (removals === 1) throw new Error("simulated run directory removal failure");
          await rm(target, { recursive: true, force: true });
        },
      },
    });
    await workspace.createRangeWorktree({
      root, toSha: sha, estimate: { entries: 1, logicalBytes: "10" },
    });
    const adminDir = (await readFile(path.join(workspace.worktreeDir, ".git"), "utf8"))
      .trim().slice("gitdir: ".length);

    await expect(workspace.cleanup()).rejects.toThrow("simulated run directory removal failure");
    expect(await exists(adminDir)).toBe(false);
    expect(await exists(workspace.runDir)).toBe(true);
    expect(await exists(workspace.worktreeDir)).toBe(false);
    expect(JSON.parse(await readFile(path.join(workspace.runDir, "worktree-owner.json"), "utf8")))
      .toMatchObject({ version: 2, state: "completed", ownerPid: process.pid, runDir: workspace.runDir });
    await workspace.cleanup();
    expect(await exists(workspace.runDir)).toBe(false);
  });

  it("restores a swapped public admin path instead of deleting it", async () => {
    const root = await initRepo();
    const sha = await git(root, "rev-parse", "HEAD");
    let adminDir = "";
    let parkedOriginal = "";
    let swapped = false;
    const workspace = await createReviewTempWorkspace("admin-swap", {
      dependencies: {
        rename: async (source, destination) => {
          if (!swapped && source === adminDir) {
            swapped = true;
            parkedOriginal = `${adminDir}-parked-original`;
            await rename(adminDir, parkedOriginal);
            await mkdir(adminDir);
          }
          await rename(source, destination);
        },
      },
    });
    roots.push(workspace.runDir);
    await workspace.createRangeWorktree({
      root, toSha: sha, estimate: { entries: 1, logicalBytes: "10" },
    });
    adminDir = (await readFile(path.join(workspace.worktreeDir, ".git"), "utf8"))
      .trim().slice("gitdir: ".length);
    await rm(workspace.worktreeDir, { recursive: true, force: true });

    await expect(workspace.cleanup()).rejects.toThrow("admin identity changed");
    expect(swapped).toBe(true);
    expect(await exists(adminDir)).toBe(true);
    expect(await exists(parkedOriginal)).toBe(true);
    expect(JSON.parse(await readFile(path.join(workspace.runDir, "worktree-owner.json"), "utf8")))
      .toMatchObject({ state: "owned", adminDir });

    await rm(adminDir, { recursive: true, force: true });
    await rename(parkedOriginal, adminDir);
    await workspace.cleanup();
  });

  it("resumes a durable quarantine when private admin deletion fails", async () => {
    const root = await initRepo();
    const sha = await git(root, "rev-parse", "HEAD");
    let failedQuarantineRemoval = false;
    const workspace = await createReviewTempWorkspace("quarantine-delete-retry", {
      dependencies: {
        removeTree: async (target) => {
          if (target.includes(".pi-adversarial-review-quarantine") && !failedQuarantineRemoval) {
            failedQuarantineRemoval = true;
            throw new Error("simulated quarantine deletion failure");
          }
          await rm(target, { recursive: true, force: true });
        },
      },
    });
    roots.push(workspace.runDir);
    await workspace.createRangeWorktree({
      root, toSha: sha, estimate: { entries: 1, logicalBytes: "10" },
    });
    const adminDir = (await readFile(path.join(workspace.worktreeDir, ".git"), "utf8"))
      .trim().slice("gitdir: ".length);
    await rm(workspace.worktreeDir, { recursive: true, force: true });

    await expect(workspace.cleanup()).rejects.toThrow("simulated quarantine deletion failure");
    expect(await exists(adminDir)).toBe(false);
    expect(JSON.parse(await readFile(path.join(workspace.runDir, "worktree-owner.json"), "utf8")))
      .toMatchObject({ state: "registration-removing", adminDir });
    await workspace.cleanup();
    expect(await exists(workspace.runDir)).toBe(false);
  });

  it("resumes after admin isolation succeeds but run-directory deletion fails", async () => {
    const root = await initRepo();
    const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-adversarial-isolation-retry-root-"));
    roots.push(tempRoot);
    const sha = await git(root, "rev-parse", "HEAD");
    let failedRunRemoval = false;
    let expectedRunDir = "";
    const workspace = await createReviewTempWorkspace("isolation-run-delete", {
      rootDir: tempRoot,
      dependencies: {
        removeTree: async (target) => {
          if (target === expectedRunDir && !failedRunRemoval) {
            failedRunRemoval = true;
            throw new Error("simulated post-isolation run deletion failure");
          }
          await rm(target, { recursive: true, force: true });
        },
      },
    });
    expectedRunDir = workspace.runDir;
    await workspace.createRangeWorktree({
      root, toSha: sha, estimate: { entries: 1, logicalBytes: "10" },
    });
    const adminDir = (await readFile(path.join(workspace.worktreeDir, ".git"), "utf8"))
      .trim().slice("gitdir: ".length);
    await rm(workspace.worktreeDir, { recursive: true, force: true });

    await expect(workspace.cleanup()).rejects.toThrow("simulated post-isolation run deletion failure");
    expect(await exists(adminDir)).toBe(false);
    expect(JSON.parse(await readFile(path.join(workspace.runDir, "worktree-owner.json"), "utf8")))
      .toMatchObject({ state: "completed", runDir: workspace.runDir });
    const staleDate = new Date(Date.now() - 2_000);
    await utimes(workspace.runDir, staleDate, staleDate);
    await expect(scavengeStaleReviewTempWorkspaces({
      rootDir: tempRoot,
      nowMs: Date.now(),
      ttlMs: 1_000,
    })).resolves.toEqual([workspace.runDir]);
    expect(await exists(workspace.runDir)).toBe(false);
  });

  it("lets TTL scavenging remove a completed workspace after run-directory deletion fails", async () => {
    const root = await initRepo();
    const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-adversarial-retry-ttl-root-"));
    roots.push(tempRoot);
    const sha = await git(root, "rev-parse", "HEAD");
    const workspace = await createReviewTempWorkspace("retry-run-delete-ttl", {
      rootDir: tempRoot,
      dependencies: { removeTree: async () => { throw new Error("simulated run directory removal failure"); } },
    });
    await workspace.createRangeWorktree({
      root, toSha: sha, estimate: { entries: 1, logicalBytes: "10" },
    });
    await expect(workspace.cleanup()).rejects.toThrow("simulated run directory removal failure");
    const staleDate = new Date(Date.now() - 2_000);
    await utimes(workspace.runDir, staleDate, staleDate);
    await expect(scavengeStaleReviewTempWorkspaces({
      rootDir: tempRoot, nowMs: Date.now(), ttlMs: 1_000,
    })).resolves.toEqual([workspace.runDir]);
    expect(await exists(workspace.runDir)).toBe(false);
  });
});

describe("review temp workspace scavenger", () => {
  it("recovers a dead scavenger quarantine and removes the exact worktree registration", async () => {
    const root = await initRepo();
    const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-adversarial-dead-scavenger-root-"));
    roots.push(tempRoot);
    const sha = await git(root, "rev-parse", "HEAD");
    const workspace = await createReviewTempWorkspace("dead-scavenger", { rootDir: tempRoot });
    const checkout = await workspace.createRangeWorktree({
      root, toSha: sha, estimate: { entries: 1, logicalBytes: "10" },
    });
    const adminDir = (await readFile(path.join(checkout, ".git"), "utf8"))
      .trim().slice("gitdir: ".length);
    const staleDate = new Date(Date.now() - 2_000);
    await utimes(workspace.runDir, staleDate, staleDate);
    const quarantine = await quarantineRunAsDeadScavenger(tempRoot, workspace.runDir, 987_654_321);

    await expect(scavengeStaleReviewTempWorkspaces({
      rootDir: tempRoot,
      nowMs: Date.now(),
      ttlMs: 1_000,
      isProcessAlive: () => false,
    })).resolves.toEqual([workspace.runDir]);
    expect(await exists(quarantine)).toBe(false);
    expect(await exists(workspace.runDir)).toBe(false);
    expect(await exists(checkout)).toBe(false);
    expect(await exists(adminDir)).toBe(false);
    expect(await git(root, "worktree", "list", "--porcelain")).not.toContain(checkout);
  });

  it("preserves a scavenger quarantine while its owner PID is live", async () => {
    const root = await initRepo();
    const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-adversarial-live-scavenger-root-"));
    roots.push(tempRoot);
    const sha = await git(root, "rev-parse", "HEAD");
    const workspace = await createReviewTempWorkspace("live-scavenger", { rootDir: tempRoot });
    await workspace.createRangeWorktree({
      root, toSha: sha, estimate: { entries: 1, logicalBytes: "10" },
    });
    const staleDate = new Date(Date.now() - 2_000);
    await utimes(workspace.runDir, staleDate, staleDate);
    const ownerPid = 987_654_320;
    const quarantine = await quarantineRunAsDeadScavenger(tempRoot, workspace.runDir, ownerPid);
    const quarantinedRun = path.join(quarantine, path.basename(workspace.runDir));
    const alive = vi.fn((pid: number) => pid === ownerPid);

    await expect(scavengeStaleReviewTempWorkspaces({
      rootDir: tempRoot, nowMs: Date.now(), ttlMs: 1_000, isProcessAlive: alive,
    })).resolves.toEqual([]);
    expect(alive).toHaveBeenCalledWith(ownerPid);
    expect(await exists(quarantine)).toBe(true);
    expect(await exists(quarantinedRun)).toBe(true);
    expect(await exists(workspace.runDir)).toBe(false);

    await rename(quarantinedRun, workspace.runDir);
    await rm(quarantine, { recursive: true, force: true });
    await workspace.cleanup();
  });

  it("preserves both a quarantined run and an occupied original path", async () => {
    const root = await initRepo();
    const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-adversarial-occupied-restore-root-"));
    roots.push(tempRoot);
    const sha = await git(root, "rev-parse", "HEAD");
    const workspace = await createReviewTempWorkspace("occupied-restore", { rootDir: tempRoot });
    await workspace.createRangeWorktree({
      root, toSha: sha, estimate: { entries: 1, logicalBytes: "10" },
    });
    const staleDate = new Date(Date.now() - 2_000);
    await utimes(workspace.runDir, staleDate, staleDate);
    const quarantine = await quarantineRunAsDeadScavenger(tempRoot, workspace.runDir, 987_654_319);
    const quarantinedRun = path.join(quarantine, path.basename(workspace.runDir));
    await mkdir(workspace.runDir);
    const occupiedProof = path.join(workspace.runDir, "unrelated.txt");
    await writeFile(occupiedProof, "preserve\n");

    await expect(scavengeStaleReviewTempWorkspaces({
      rootDir: tempRoot,
      nowMs: Date.now(),
      ttlMs: 1_000,
      isProcessAlive: () => false,
    })).resolves.toEqual([]);
    expect(await readFile(occupiedProof, "utf8")).toBe("preserve\n");
    expect(await exists(quarantinedRun)).toBe(true);
    expect(await exists(quarantine)).toBe(true);

    await rm(workspace.runDir, { recursive: true, force: true });
    await rename(quarantinedRun, workspace.runDir);
    await rm(quarantine, { recursive: true, force: true });
    await workspace.cleanup();
  });

  it("persists a private owner marker before moving a stale candidate", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-adversarial-marker-order-root-"));
    roots.push(tempRoot);
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
    const numericUid = typeof process.getuid === "function" ? process.getuid() : -1;
    const runDir = path.join(tempRoot, `pi-adversarial-review-${uid}-marker-order`);
    await mkdir(runDir);
    await writeFile(path.join(runDir, "input.md"), "stale\n");
    const nowMs = Date.now();
    const staleDate = new Date(nowMs - 2_000);
    await utimes(runDir, staleDate, staleDate);
    let markerObserved = false;

    await expect(scavengeStaleReviewTempWorkspaces({
      rootDir: tempRoot,
      nowMs,
      ttlMs: 1_000,
      dependencies: {
        rename: async (source, destination) => {
          if (source === runDir) {
            if (typeof destination !== "string") throw new Error("Expected a string quarantine path.");
            const markerPath = path.join(path.dirname(destination), "scavenge-owner.json");
            const markerInfo = await lstat(markerPath);
            expect(markerInfo.isFile()).toBe(true);
            expect(markerInfo.uid).toBe(numericUid);
            expect(markerInfo.mode & 0o777).toBe(0o600);
            expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual({
              version: 1,
              ownerPid: process.pid,
            });
            markerObserved = true;
          }
          await rename(source, destination);
        },
      },
    })).resolves.toEqual([runDir]);
    expect(markerObserved).toBe(true);
  });

  it("waits for TTL before recovering an unmarked abandoned quarantine", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-adversarial-unmarked-scavenger-root-"));
    roots.push(tempRoot);
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
    const runDir = path.join(tempRoot, `pi-adversarial-review-${uid}-unmarked`);
    await mkdir(runDir);
    await writeFile(path.join(runDir, "input.md"), "stale\n");
    const nowMs = Date.now();
    const staleDate = new Date(nowMs - 2_000);
    await utimes(runDir, staleDate, staleDate);
    const quarantine = await mkdtemp(
      path.join(tempRoot, `pi-adversarial-review-scavenge-${uid}-`),
    );
    await rename(runDir, path.join(quarantine, path.basename(runDir)));

    await expect(scavengeStaleReviewTempWorkspaces({
      rootDir: tempRoot, nowMs, ttlMs: 1_000,
    })).resolves.toEqual([]);
    expect(await exists(quarantine)).toBe(true);
    expect(await exists(runDir)).toBe(false);

    await expect(scavengeStaleReviewTempWorkspaces({
      rootDir: tempRoot, nowMs: nowMs + 1_001, ttlMs: 1_000,
    })).resolves.toEqual([runDir]);
    expect(await exists(quarantine)).toBe(false);
    expect(await exists(runDir)).toBe(false);
  });

  it("leaves candidates and unrelated paths intact when quarantine marker initialization fails", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-adversarial-marker-failure-root-"));
    roots.push(tempRoot);
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
    const runDir = path.join(tempRoot, `pi-adversarial-review-${uid}-retry`);
    const unrelated = path.join(tempRoot, "unrelated");
    await mkdir(runDir);
    await mkdir(unrelated);
    await writeFile(path.join(runDir, "input.md"), "stale\n");
    await writeFile(path.join(unrelated, "proof.txt"), "preserve\n");
    const nowMs = Date.now();
    const staleDate = new Date(nowMs - 2_000);
    await utimes(runDir, staleDate, staleDate);
    const failMarker = vi.fn(async () => { throw new Error("simulated marker failure"); });

    await expect(scavengeStaleReviewTempWorkspaces({
      rootDir: tempRoot,
      nowMs,
      ttlMs: 1_000,
      dependencies: { writeScavengeMarker: failMarker },
    })).resolves.toEqual([]);
    expect(failMarker).toHaveBeenCalledOnce();
    expect(await exists(runDir)).toBe(true);
    expect(await readFile(path.join(unrelated, "proof.txt"), "utf8")).toBe("preserve\n");

    await expect(scavengeStaleReviewTempWorkspaces({
      rootDir: tempRoot, nowMs, ttlMs: 1_000,
    })).resolves.toEqual([runDir]);
    expect(await readFile(path.join(unrelated, "proof.txt"), "utf8")).toBe("preserve\n");
  });

  it("leases local/base-style workspaces to a live PID and removes them after that PID is dead", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-adversarial-workspace-lease-root-"));
    roots.push(tempRoot);
    const workspace = await createReviewTempWorkspace("local-base-only", { rootDir: tempRoot });
    const manifestPath = path.join(workspace.runDir, "worktree-owner.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest).toEqual({
      version: 2,
      state: "workspace",
      ownerPid: process.pid,
      runDir: workspace.runDir,
    });
    const staleDate = new Date(Date.now() - 2_000);
    await utimes(workspace.runDir, staleDate, staleDate);

    const alive = vi.fn(() => true);
    await expect(scavengeStaleReviewTempWorkspaces({
      rootDir: tempRoot,
      nowMs: Date.now(),
      ttlMs: 1_000,
      currentCwd: tempRoot,
      isProcessAlive: alive,
    })).resolves.toEqual([]);
    expect(alive).toHaveBeenCalledWith(process.pid);
    expect(await exists(workspace.runDir)).toBe(true);

    await expect(scavengeStaleReviewTempWorkspaces({
      rootDir: tempRoot,
      nowMs: Date.now(),
      ttlMs: 1_000,
      currentCwd: tempRoot,
      isProcessAlive: () => false,
    })).resolves.toEqual([workspace.runDir]);
    expect(await exists(workspace.runDir)).toBe(false);
  });

  it("removes stale plain same-UID directories and never follows symlinks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-adversarial-ttl-test-"));
    roots.push(root);
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
    const prefix = `pi-adversarial-review-${uid}-`;
    const stale = path.join(root, `${prefix}stale`);
    const fresh = path.join(root, `${prefix}fresh`);
    const unrelated = path.join(root, "pi-adversarial-review-other-stale");
    const victim = path.join(root, "victim");
    const linked = path.join(root, `${prefix}linked`);
    for (const directory of [stale, fresh, unrelated, victim]) {
      await mkdir(directory);
      await writeFile(path.join(directory, "input.md"), "data");
    }
    await symlink(victim, linked, "dir");
    const nowMs = Date.now();
    const staleDate = new Date(nowMs - 1_001);
    await utimes(stale, staleDate, staleDate);
    await utimes(unrelated, staleDate, staleDate);
    await chmod(stale, 0o500);
    await chmod(path.join(stale, "input.md"), 0o400);

    await expect(scavengeStaleReviewTempWorkspaces({ rootDir: root, nowMs, ttlMs: 1_000 }))
      .resolves.toEqual([stale]);
    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(unrelated)).toBe(true);
    expect(await exists(linked)).toBe(true);
    expect(await exists(path.join(victim, "input.md"))).toBe(true);
    expect((await readdir(root)).some((entry) => entry.includes("-scavenge-"))).toBe(false);
  });

  it("recovers only a stale marker-proven extension worktree and exact admin entry", async () => {
    const root = await initRepo();
    const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-adversarial-owned-root-"));
    roots.push(tempRoot);
    const sha = await git(root, "rev-parse", "HEAD");
    const workspace = await createReviewTempWorkspace("stale-owned", { rootDir: tempRoot });
    const cwd = await workspace.createRangeWorktree({
      root,
      toSha: sha,
      estimate: { entries: 1, logicalBytes: "10" },
    });
    const dotGit = await readFile(path.join(cwd, ".git"), "utf8");
    const adminDir = dotGit.trim().slice("gitdir: ".length);
    const staleDate = new Date(Date.now() - 2_000);
    await utimes(workspace.runDir, staleDate, staleDate);

    await expect(scavengeStaleReviewTempWorkspaces({
      rootDir: tempRoot,
      nowMs: Date.now(),
      ttlMs: 1_000,
      isProcessAlive: () => false,
    })).resolves.toEqual([workspace.runDir]);
    expect(await exists(workspace.runDir)).toBe(false);
    expect(await exists(adminDir)).toBe(false);
    expect(await git(root, "worktree", "list", "--porcelain")).not.toContain(cwd);
  });

  it("preserves both registrations when another worktree is substituted at the owned path", async () => {
    const root = await initRepo();
    const otherRoot = await initRepo();
    const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-adversarial-substitution-root-"));
    roots.push(tempRoot);
    const sha = await git(root, "rev-parse", "HEAD");
    const otherSha = await git(otherRoot, "rev-parse", "HEAD");
    const workspace = await createReviewTempWorkspace("substitution", { rootDir: tempRoot });
    await workspace.createRangeWorktree({
      root, toSha: sha, estimate: { entries: 1, logicalBytes: "10" },
    });
    const parked = path.join(tempRoot, "parked-owned-checkout");
    await rename(workspace.worktreeDir, parked);
    await git(otherRoot, "worktree", "add", "--detach", workspace.worktreeDir, otherSha);
    const originalRegistrations = await git(root, "worktree", "list", "--porcelain");
    const otherRegistrations = await git(otherRoot, "worktree", "list", "--porcelain");
    const staleDate = new Date(Date.now() - 2_000);
    await utimes(workspace.runDir, staleDate, staleDate);

    await expect(scavengeStaleReviewTempWorkspaces({
      rootDir: tempRoot,
      nowMs: Date.now(),
      ttlMs: 1_000,
      currentCwd: tempRoot,
      isProcessAlive: () => false,
    })).resolves.toEqual([]);
    expect(await exists(workspace.runDir)).toBe(true);
    expect(await git(root, "worktree", "list", "--porcelain")).toBe(originalRegistrations);
    expect(await git(otherRoot, "worktree", "list", "--porcelain")).toBe(otherRegistrations);

    await git(otherRoot, "worktree", "remove", "--force", workspace.worktreeDir);
    await rename(parked, workspace.worktreeDir);
    await workspace.cleanup();
  });

  it("preserves stale candidates containing cwd or owned by a live PID", async () => {
    const root = await initRepo();
    const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-adversarial-live-root-"));
    roots.push(tempRoot);
    const sha = await git(root, "rev-parse", "HEAD");
    const workspace = await createReviewTempWorkspace("live-owner", { rootDir: tempRoot });
    await workspace.createRangeWorktree({
      root, toSha: sha, estimate: { entries: 1, logicalBytes: "10" },
    });
    const staleDate = new Date(Date.now() - 2_000);
    await utimes(workspace.runDir, staleDate, staleDate);

    const previousCwd = process.cwd();
    try {
      process.chdir(workspace.worktreeDir);
      await expect(scavengeStaleReviewTempWorkspaces({
        rootDir: tempRoot, nowMs: Date.now(), ttlMs: 1_000, isProcessAlive: () => false,
      })).resolves.toEqual([]);
    } finally {
      process.chdir(previousCwd);
    }
    const alive = vi.fn(() => true);
    await expect(scavengeStaleReviewTempWorkspaces({
      rootDir: tempRoot,
      nowMs: Date.now(),
      ttlMs: 1_000,
      currentCwd: root,
      isProcessAlive: alive,
    })).resolves.toEqual([]);
    expect(alive).toHaveBeenCalledWith(process.pid);
    expect(await exists(workspace.worktreeDir)).toBe(true);
    await workspace.cleanup();
  });

  it("preserves mismatched ownership metadata and an unrelated user worktree without prune", async () => {
    const root = await initRepo();
    const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-adversarial-preserve-root-"));
    roots.push(tempRoot);
    const sha = await git(root, "rev-parse", "HEAD");
    const workspace = await createReviewTempWorkspace("mismatch", { rootDir: tempRoot });
    const cwd = await workspace.createRangeWorktree({
      root,
      toSha: sha,
      estimate: { entries: 1, logicalBytes: "10" },
    });
    const adminDir = (await readFile(path.join(cwd, ".git"), "utf8")).trim().slice("gitdir: ".length);
    const markerPath = path.join(adminDir, "pi-adversarial-review-owner.json");
    const originalMarker = await readFile(markerPath, "utf8");
    await writeFile(markerPath, JSON.stringify({ version: 1, token: "mismatch", worktreePath: cwd }));
    const staleDate = new Date(Date.now() - 2_000);
    await utimes(workspace.runDir, staleDate, staleDate);

    await expect(scavengeStaleReviewTempWorkspaces({
      rootDir: tempRoot, nowMs: Date.now(), ttlMs: 1_000, isProcessAlive: () => false,
    })).resolves.toEqual([]);
    expect(await exists(workspace.runDir)).toBe(true);
    expect(await exists(adminDir)).toBe(true);

    await writeFile(markerPath, originalMarker);
    await workspace.cleanup();

    const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
    const userRun = path.join(tempRoot, `pi-adversarial-review-${uid}-user-worktree`);
    roots.push(userRun);
    await git(root, "worktree", "add", "--detach", userRun, sha);
    await utimes(userRun, staleDate, staleDate);
    const registrations = await git(root, "worktree", "list", "--porcelain");
    await expect(scavengeStaleReviewTempWorkspaces({
      rootDir: tempRoot, nowMs: Date.now(), ttlMs: 1_000,
    })).resolves.toEqual([]);
    expect(await exists(userRun)).toBe(true);
    expect(await git(root, "worktree", "list", "--porcelain")).toBe(registrations);
    await git(root, "worktree", "remove", "--force", userRun);
  });

  it("is best-effort for missing roots and rejects invalid TTL configuration", async () => {
    await expect(scavengeStaleReviewTempWorkspaces({
      rootDir: "/definitely/missing/pi-adversarial-review", ttlMs: 1_000,
    })).resolves.toEqual([]);
    await expect(scavengeStaleReviewTempWorkspaces({ ttlMs: 0 })).rejects.toThrow(
      "Review temp TTL must be positive",
    );
  });
});
