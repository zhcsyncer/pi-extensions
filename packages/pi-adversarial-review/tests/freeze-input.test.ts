import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertFrozenInputWithinLimits,
  EmptyReviewInputError,
  measureFrozenInput,
  OversizedReviewInputError,
  prepareFrozenReviewInput,
} from "../src/input/freeze-input.ts";

const exec = promisify(execFile);
const repos: string[] = [];

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: root, encoding: "utf8" });
  return stdout.trim();
}

async function initRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-adversarial-input-"));
  repos.push(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "review@example.test");
  await git(root, "config", "user.name", "Review Test");
  return root;
}

async function commitAll(root: string, message: string): Promise<string> {
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("prepareFrozenReviewInput", () => {
  it("freezes staged, unstaged, and non-ignored untracked local changes", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(root, "staged.txt"), "base staged\n");
    await writeFile(path.join(root, "unstaged.txt"), "base unstaged\n");
    await commitAll(root, "base");

    await appendFile(path.join(root, "staged.txt"), "staged change\n");
    await git(root, "add", "staged.txt");
    await appendFile(path.join(root, "unstaged.txt"), "unstaged change\n");
    await writeFile(path.join(root, "untracked file.txt"), "untracked change\n");
    await writeFile(path.join(root, "ignored.txt"), "must stay out\n");
    const nested = path.join(root, "nested");
    await mkdir(nested);

    const frozen = await prepareFrozenReviewInput({
      cwd: nested,
      target: { mode: "local" },
      focus: "failure recovery",
      runId: randomUUID(),
    });

    const content = await readFile(frozen.inputPath, "utf8");
    expect(frozen.target.root).toBe(root);
    expect(frozen.target.changedFiles).toEqual([
      "staged.txt",
      "unstaged.txt",
      "untracked file.txt",
    ]);
    expect(content).toContain("staged change");
    expect(content).toContain("unstaged change");
    expect(content).toContain("untracked change");
    expect(content).not.toContain("must stay out");
    expect(content).toContain("failure recovery");
    expect((await stat(frozen.inputPath)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(frozen.inputPath))).mode & 0o777).toBe(0o700);
    await expect(frozen.recheck()).resolves.toEqual({ stale: false, changed: [] });

    await appendFile(path.join(root, "unstaged.txt"), "drift\n");
    const drift = await frozen.recheck();
    expect(drift.stale).toBe(true);
    expect(drift.changed).toContain("target");

    const runDir = path.dirname(frozen.inputPath);
    await frozen.cleanup();
    await frozen.cleanup();
    expect(await exists(runDir)).toBe(false);
  });

  it("includes committed and working-tree changes for a base target", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "app.ts"), "export const value = 1;\n");
    const baseSha = await commitAll(root, "base");
    await writeFile(path.join(root, "app.ts"), "export const value = 2;\n");
    await commitAll(root, "feature");
    await writeFile(path.join(root, "working.ts"), "working tree\n");

    const frozen = await prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "base", baseRef: baseSha },
      runId: randomUUID(),
    });
    try {
      const content = await readFile(frozen.inputPath, "utf8");
      expect(frozen.target.baseSha).toBe(baseSha);
      expect(frozen.target.changedFiles).toEqual(["app.ts", "working.ts"]);
      expect(content).toContain("Committed base patch");
      expect(content).toContain("export const value = 2");
      expect(content).toContain("working tree");
    } finally {
      await frozen.cleanup();
    }
  });

  it("uses a read-only refB snapshot for range review", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "version.txt"), "A\n");
    await writeFile(path.join(root, ".gitattributes"), "exported-secret.txt export-ignore\n");
    const fromSha = await commitAll(root, "A");
    await writeFile(path.join(root, "version.txt"), "B\n");
    await writeFile(path.join(root, "added.txt"), "at B\n");
    await writeFile(path.join(root, "exported-secret.txt"), "must remain in exact snapshot\n");
    const toSha = await commitAll(root, "B");
    await writeFile(path.join(root, "version.txt"), "C\n");
    await commitAll(root, "C");

    const frozen = await prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "range", fromRef: fromSha, toRef: toSha },
      runId: randomUUID(),
    });
    try {
      expect(frozen.reviewerCwd).not.toBe(root);
      expect(await readFile(path.join(frozen.reviewerCwd, "version.txt"), "utf8")).toBe("B\n");
      expect(await readFile(path.join(frozen.reviewerCwd, "exported-secret.txt"), "utf8"))
        .toBe("must remain in exact snapshot\n");
      expect(await readFile(path.join(root, "version.txt"), "utf8")).toBe("C\n");
      expect((await stat(frozen.reviewerCwd)).mode & 0o777).toBe(0o555);
      expect((await stat(path.join(frozen.reviewerCwd, "version.txt"))).mode & 0o777).toBe(0o444);
      expect(frozen.target.changedFiles).toEqual(["added.txt", "exported-secret.txt", "version.txt"]);
    } finally {
      await frozen.cleanup();
    }
  });

  it("treats an untracked-only target as reviewable and rejects a clean target", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "tracked.txt"), "base\n");
    await commitAll(root, "base");

    await expect(prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "local" },
      runId: randomUUID(),
    })).rejects.toBeInstanceOf(EmptyReviewInputError);

    await writeFile(path.join(root, "only-untracked.txt"), "new\n");
    const frozen = await prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "local" },
      runId: randomUUID(),
    });
    expect(frozen.target.changedFiles).toEqual(["only-untracked.txt"]);
    await frozen.cleanup();

    await rm(path.join(root, "only-untracked.txt"));
    await writeFile(path.join(root, "empty-untracked.txt"), "");
    const emptyFileFrozen = await prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "local" },
      runId: randomUUID(),
    });
    expect(emptyFileFrozen.target.changedFiles).toEqual(["empty-untracked.txt"]);
    await emptyFileFrozen.cleanup();
  });

  it("re-resolves movable refs during drift detection", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "app.ts"), "base\n");
    const baseSha = await commitAll(root, "base");
    await git(root, "branch", "moving-base", baseSha);
    await writeFile(path.join(root, "app.ts"), "feature\n");
    await commitAll(root, "feature");

    const frozen = await prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "base", baseRef: "moving-base" },
      runId: randomUUID(),
    });
    try {
      await expect(frozen.recheck()).resolves.toEqual({ stale: false, changed: [] });
      await git(root, "branch", "-f", "moving-base", "HEAD");
      const drift = await frozen.recheck();
      expect(drift).toEqual({ stale: true, changed: ["target"] });
    } finally {
      await frozen.cleanup();
    }
  });

  it("ignores user diff.ignoreSubmodules when freezing a gitlink update", async () => {
    const source = await initRepo();
    await writeFile(path.join(source, "sub.txt"), "one\n");
    await commitAll(source, "sub-one");

    const root = await initRepo();
    await writeFile(path.join(root, "root.txt"), "root\n");
    await commitAll(root, "root");
    await exec("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "vendor/sub"], {
      cwd: root,
    });
    await commitAll(root, "add submodule");

    await writeFile(path.join(source, "sub.txt"), "two\n");
    const nextSubSha = await commitAll(source, "sub-two");
    const checkout = path.join(root, "vendor/sub");
    await git(checkout, "fetch", "-q", "origin");
    await git(checkout, "checkout", "-q", nextSubSha);
    await git(root, "add", "vendor/sub");
    await git(root, "config", "diff.ignoreSubmodules", "all");

    const frozen = await prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "local" },
      runId: randomUUID(),
    });
    try {
      expect(frozen.target.changedFiles).toContain("vendor/sub");
      expect(await readFile(frozen.inputPath, "utf8")).toContain("Subproject commit");
    } finally {
      await frozen.cleanup();
    }
  });

  it("never uses caller-provided runId as a filesystem path", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "tracked.txt"), "base\n");
    await commitAll(root, "base");
    await appendFile(path.join(root, "tracked.txt"), "change\n");

    const victim = await mkdtemp(path.join(tmpdir(), "pi-adversarial-victim-"));
    repos.push(victim);
    const marker = path.join(victim, "marker.txt");
    await writeFile(marker, "keep\n");
    const maliciousRunId = `../../../${path.basename(victim)}`;

    const frozen = await prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "local" },
      runId: maliciousRunId,
    });
    expect(frozen.runId).toBe(maliciousRunId);
    expect(path.dirname(frozen.inputPath)).not.toBe(victim);
    await frozen.cleanup();
    expect(await readFile(marker, "utf8")).toBe("keep\n");
  });

  it("rejects oversized Git and reqdoc inputs before creating a workspace", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "tracked.txt"), "base\n");
    await commitAll(root, "base");
    await appendFile(path.join(root, "tracked.txt"), "x".repeat(4_096));

    await expect(prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "local" },
      runId: randomUUID(),
      maxBytes: 1_024,
      maxLines: 5_000,
    })).rejects.toBeInstanceOf(OversizedReviewInputError);

    await writeFile(path.join(root, "tracked.txt"), "base\nsmall\n");
    await writeFile(path.join(root, "requirements.md"), "r".repeat(4_096));
    await commitAll(root, "add large requirement");
    await appendFile(path.join(root, "tracked.txt"), "review change\n");
    await expect(prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "local" },
      reqdoc: "requirements.md",
      runId: randomUUID(),
      maxBytes: 2_048,
      maxLines: 5_000,
    })).rejects.toBeInstanceOf(OversizedReviewInputError);
  });

  it("rejects invalid refs, non-repositories, and reqdocs outside the repository", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "tracked.txt"), "base\n");
    await commitAll(root, "base");
    await appendFile(path.join(root, "tracked.txt"), "change\n");

    await expect(prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "base", baseRef: "missing-ref" },
    })).rejects.toThrow('Git ref "missing-ref" does not resolve to a commit');

    await expect(prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "local" },
      reqdoc: "../outside.md",
    })).rejects.toThrow("--reqdoc must resolve to a file inside the Git repository");

    const outside = await mkdtemp(path.join(tmpdir(), "pi-adversarial-not-git-"));
    repos.push(outside);
    await expect(prepareFrozenReviewInput({
      cwd: outside,
      target: { mode: "local" },
    })).rejects.toThrow("Not inside a Git repository");
  });
});

describe("frozen input limits", () => {
  it("accepts exact byte/line limits and rejects one unit over", () => {
    expect(assertFrozenInputWithinLimits("a\nb\n", 4, 2)).toEqual({ bytes: 4, lines: 2 });
    expect(() => assertFrozenInputWithinLimits("a\nb\n!", 4, 3)).toThrow(OversizedReviewInputError);
    expect(() => assertFrozenInputWithinLimits("a\nb\nc", 5, 2)).toThrow(OversizedReviewInputError);
  });

  it("measures UTF-8 bytes independently from logical lines", () => {
    expect(measureFrozenInput("你\n好")).toEqual({ bytes: 7, lines: 2 });
  });
});
