import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, appendFile, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const workspaceHooks = vi.hoisted(() => ({
  onCreated: undefined as undefined | ((workspace: {
    runDir: string;
    cleanup(): Promise<void>;
  }) => void),
}));

vi.mock("../src/input/temp-workspace.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/input/temp-workspace.ts")>();
  return {
    ...actual,
    createReviewTempWorkspace: async (...args: Parameters<typeof actual.createReviewTempWorkspace>) => {
      const workspace = await actual.createReviewTempWorkspace(...args);
      workspaceHooks.onCreated?.(workspace);
      return workspace;
    },
  };
});

import {
  assertFrozenInputWithinLimits,
  EmptyReviewInputError,
  fingerprintReviewTarget,
  MAX_FROZEN_INPUT_BYTES,
  MAX_FROZEN_INPUT_LINES,
  measureFrozenInput,
  OversizedReviewInputError,
  prepareFrozenReviewInput,
  RECOMMENDED_FROZEN_INPUT_BYTES,
  RECOMMENDED_FROZEN_INPUT_LINES,
  suggestReviewRanges,
} from "../src/input/freeze-input.ts";
import { ReviewInputCleanupError } from "../src/input/errors.ts";
import { extractRangeSnapshot, resolveReviewTarget } from "../src/input/git-target.ts";

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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  workspaceHooks.onCreated = undefined;
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

    const fingerprint = await fingerprintReviewTarget({
      cwd: nested,
      target: { mode: "local" },
      focus: "failure recovery",
    });
    const frozen = await prepareFrozenReviewInput({
      cwd: nested,
      target: { mode: "local" },
      preflight: {
        selection: "inferred",
        fetchStatus: "succeeded",
        branch: "feature/review",
        remote: "origin",
        fetchedRemotes: ["origin"],
        defaultBranchRef: "origin/main",
        ahead: 2,
        behind: 0,
      },
      focus: "failure recovery",
      runId: randomUUID(),
    });

    const content = await readFile(frozen.inputPath, "utf8");
    expect(frozen.target.root).toBe(root);
    expect(frozen.inputSize).toEqual(measureFrozenInput(content));
    expect(frozen.inputSize).toEqual(fingerprint.inputSize);
    expect(frozen.inputSha256).toBe(fingerprint.inputSha256);
    expect(frozen.target.preflight).toEqual({
      selection: "inferred",
      fetchStatus: "succeeded",
      branch: "feature/review",
      remote: "origin",
      fetchedRemotes: ["origin"],
      defaultBranchRef: "origin/main",
      ahead: 2,
      behind: 0,
    });
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
    const outputContract = content.slice(content.indexOf("## Output contract"));
    expect(outputContract).toContain('"verdict": "needs-attention | approve"');
    expect(outputContract).not.toContain("```");
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

  it("cancels an in-flight fingerprint command and leaves no SIGTERM-ignoring descendant", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "tracked.ts"), "export const value = 1;\n");
    await commitAll(root, "base");
    await writeFile(path.join(root, "tracked.ts"), "export const value = 2;\n");
    const bin = path.join(root, "bin");
    const parentFile = path.join(root, "fake-git.pid");
    const childFile = path.join(root, "fake-git-child.pid");
    await mkdir(bin);
    const fakeGit = path.join(bin, "git");
    await writeFile(
      fakeGit,
      `#!/bin/sh\necho $$ > ${JSON.stringify(parentFile)}\nsh -c 'trap "" TERM; echo $$ > "$1"; while :; do sleep 1; done' child ${JSON.stringify(childFile)} &\ntrap '' TERM\nwait\n`,
    );
    await chmod(fakeGit, 0o700);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    const controller = new AbortController();
    const running = fingerprintReviewTarget({
      cwd: root,
      target: { mode: "local" },
      signal: controller.signal,
    });
    let childPid = 0;
    try {
      await vi.waitFor(async () => {
        expect(await exists(parentFile)).toBe(true);
        expect(await exists(childFile)).toBe(true);
      });
      childPid = Number((await readFile(childFile, "utf8")).trim());
      controller.abort(new Error("cancel fingerprint"));
      await expect(running).rejects.toThrow("cancel fingerprint");
      await vi.waitFor(() => expect(processAlive(childPid)).toBe(false), { timeout: 2_000 });
    } finally {
      controller.abort(new Error("fingerprint test cleanup"));
      await running.catch(() => {});
      process.env.PATH = previousPath;
      if (childPid > 0 && processAlive(childPid)) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });

  it("changes targetSha256 when modified content changes but porcelain status stays identical", async () => {
    const root = await initRepo();
    const file = path.join(root, "tracked.ts");
    await writeFile(file, "export const value = 'base';\n");
    await commitAll(root, "base");
    await writeFile(file, "export const value = 'first';\n");
    const first = await fingerprintReviewTarget({ cwd: root, target: { mode: "local" } });

    await writeFile(file, "export const value = 'other';\n");
    const second = await fingerprintReviewTarget({ cwd: root, target: { mode: "local" } });

    expect(second.headSha).toBe(first.headSha);
    expect(second.statusSha256).toBe(first.statusSha256);
    expect(second.targetSha256).not.toBe(first.targetSha256);
  });

  it("rejects content that changes between patch capture and final status", async () => {
    const root = await initRepo();
    const file = path.join(root, "tracked.ts");
    await writeFile(file, "export const value = 'base';\n");
    await commitAll(root, "base");
    await writeFile(file, "export const value = 'first';\n");
    const tools = await mkdtemp(path.join(tmpdir(), "pi-adversarial-git-wrapper-"));
    repos.push(tools);
    const marker = path.join(tools, "mutated");
    const realGit = (await exec("which", ["git"], { encoding: "utf8" })).stdout.trim();
    const wrapper = path.join(tools, "git");
    await writeFile(wrapper, `#!/bin/sh\nif [ "$1" = status ] && [ ! -e ${JSON.stringify(marker)} ]; then\n  printf '%s\\n' ${JSON.stringify("export const value = 'other';")} > ${JSON.stringify(file)}\n  touch ${JSON.stringify(marker)}\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`);
    await chmod(wrapper, 0o700);
    const previousPath = process.env.PATH;
    process.env.PATH = `${tools}${path.delimiter}${previousPath ?? ""}`;
    try {
      await expect(fingerprintReviewTarget({
        cwd: root,
        target: { mode: "local" },
      })).rejects.toThrow("Git content changed while fingerprinting");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("rejects a target ref that moves during fingerprint capture", async () => {
    const root = await initRepo();
    const file = path.join(root, "tracked.ts");
    await writeFile(file, "export const value = 'base';\n");
    const base = await commitAll(root, "base");
    await writeFile(file, "export const value = 'future';\n");
    const future = await commitAll(root, "future");
    await git(root, "reset", "--hard", base);
    await git(root, "update-ref", "refs/remotes/origin/main", base);
    await writeFile(file, "export const value = 'local';\n");
    const tools = await mkdtemp(path.join(tmpdir(), "pi-adversarial-ref-wrapper-"));
    repos.push(tools);
    const marker = path.join(tools, "moved");
    const realGit = (await exec("which", ["git"], { encoding: "utf8" })).stdout.trim();
    const wrapper = path.join(tools, "git");
    await writeFile(wrapper, `#!/bin/sh\nif [ "$1" = status ] && [ ! -e ${JSON.stringify(marker)} ]; then\n  ${JSON.stringify(realGit)} -C ${JSON.stringify(root)} update-ref refs/remotes/origin/main ${JSON.stringify(future)}\n  touch ${JSON.stringify(marker)}\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`);
    await chmod(wrapper, 0o700);
    const previousPath = process.env.PATH;
    process.env.PATH = `${tools}${path.delimiter}${previousPath ?? ""}`;
    try {
      await expect(fingerprintReviewTarget({
        cwd: root,
        target: { mode: "base", baseRef: "origin/main" },
      })).rejects.toThrow("Git target refs changed while fingerprinting");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("freezes rename, delete, and binary changes without mutating the worktree", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "rename-old.txt"), "stable content for rename detection\n".repeat(8));
    await writeFile(path.join(root, "deleted.txt"), "delete me\n");
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));
    await commitAll(root, "base special files");

    await git(root, "mv", "rename-old.txt", "rename-new.txt");
    await rm(path.join(root, "deleted.txt"));
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 9, 8, 7, 6, 5]));
    const before = await git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all");

    const frozen = await prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "local" },
      runId: randomUUID(),
    });
    try {
      const content = await readFile(frozen.inputPath, "utf8");
      expect(frozen.target.changedFiles).toEqual(expect.arrayContaining([
        "binary.bin", "deleted.txt", "rename-new.txt",
      ]));
      expect(content).toContain("rename from rename-old.txt");
      expect(content).toContain("rename to rename-new.txt");
      expect(content).toContain("deleted file mode");
      expect(content).toContain("GIT binary patch");
      expect(frozen.limitedContext).toContain(
        "Binary file content is not directly inspectable from the frozen patch.",
      );
    } finally {
      await frozen.cleanup();
    }
    expect(await git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all"))
      .toBe(before);
  });

  it("never executes configured textconv, content filters, or fsmonitor while freezing", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, ".gitattributes"), "*.txt diff=a=b filter=a=b\n");
    await writeFile(path.join(root, "tracked.txt"), "base\n");
    await commitAll(root, "textconv base");
    const marker = path.join(root, ".git", "textconv-ran");
    const script = path.join(root, ".git", "evil-textconv.sh");
    await writeFile(
      script,
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nif [ "$#" -gt 0 ]; then cat "$1"; else cat; fi\n`,
    );
    await chmod(script, 0o700);
    await git(root, "config", "diff.a=b.textconv", script);
    await git(root, "config", "filter.a=b.clean", script);
    await git(root, "config", "filter.a=b.process", script);
    await git(root, "config", "core.fsmonitor", script);
    await appendFile(path.join(root, "tracked.txt"), "change\n");

    const frozen = await prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "local" },
      runId: randomUUID(),
    });
    await frozen.cleanup();
    expect(await exists(marker)).toBe(false);
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
    await writeFile(path.join(root, "..foo.txt"), "legal dot-dot prefix\n");
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
      expect(await readFile(path.join(frozen.reviewerCwd, "..foo.txt"), "utf8"))
        .toBe("legal dot-dot prefix\n");
      expect(await readFile(path.join(root, "version.txt"), "utf8")).toBe("C\n");
      expect((await stat(frozen.reviewerCwd)).mode & 0o777).toBe(0o555);
      expect((await stat(path.join(frozen.reviewerCwd, "version.txt"))).mode & 0o777).toBe(0o444);
      expect(frozen.target.changedFiles).toEqual([
        "..foo.txt", "added.txt", "exported-secret.txt", "version.txt",
      ]);
    } finally {
      await frozen.cleanup();
    }
  });

  it("keeps a symlink that resolves inside the snapshot from its nested parent", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "inside.txt"), "snapshot-only\n");
    const fromSha = await commitAll(root, "internal symlink base");
    await mkdir(path.join(root, "nested"));
    await symlink("../inside.txt", path.join(root, "nested", "inside-link"));
    const toSha = await commitAll(root, "internal symlink");

    const frozen = await prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "range", fromRef: fromSha, toRef: toSha },
      runId: randomUUID(),
    });
    try {
      expect(await readlink(path.join(frozen.reviewerCwd, "nested", "inside-link")))
        .toBe("../inside.txt");
      expect(await readFile(path.join(frozen.reviewerCwd, "nested", "inside-link"), "utf8"))
        .toBe("snapshot-only\n");
    } finally {
      await frozen.cleanup();
    }
  });

  it.each([
    ["absolute", (root: string) => path.join(path.dirname(root), `outside-${randomUUID()}`), "absolute-link"],
    ["Windows drive-relative", (_root: string) => "C:outside-secret", "drive-link"],
    ["parent escape", (_root: string) => `../outside-${randomUUID()}`, "escape-link"],
    ["nested parent escape", (_root: string) => `../../outside-${randomUUID()}`, "nested/escape-link"],
    ["Windows-separator parent escape", (_root: string) => `..\\outside-${randomUUID()}`, "windows-escape-link"],
  ])("rejects an %s symlink target without exposing an external file", async (_label, targetFor, linkFile) => {
    const root = await initRepo();
    await writeFile(path.join(root, "base.txt"), "base\n");
    const fromSha = await commitAll(root, "escaping symlink base");
    await mkdir(path.dirname(path.join(root, linkFile)), { recursive: true });
    const linkTarget = targetFor(root);
    const externalPath = path.isAbsolute(linkTarget)
      ? linkTarget
      : path.resolve(path.dirname(path.join(root, linkFile)), linkTarget);
    repos.push(externalPath);
    await writeFile(externalPath, "must not be readable through snapshot\n");
    await symlink(linkTarget, path.join(root, linkFile));
    const toSha = await commitAll(root, "escaping symlink");
    const destination = await mkdtemp(path.join(tmpdir(), "pi-adversarial-snapshot-"));
    repos.push(destination);

    await expect(extractRangeSnapshot(root, toSha, destination)).rejects.toThrow(
      /Git symlink (?:target is absolute or drive-relative|graph escapes the snapshot)/u,
    );
    await expect(readFile(path.join(destination, linkFile), "utf8")).rejects.toThrow();
    expect(await readFile(externalPath, "utf8")).toBe("must not be readable through snapshot\n");
    expect(fromSha).not.toBe(toSha);
  });

  it("rejects a chain whose inner symlink changes how remaining dot-dot components resolve", async () => {
    const root = await initRepo();
    await mkdir(path.join(root, "dir"));
    await symlink("..", path.join(root, "dir", "a"));
    await symlink("dir/a/../outside-secret", path.join(root, "x"));
    const toSha = await commitAll(root, "component-order symlink escape");
    const snapshotParent = await mkdtemp(path.join(tmpdir(), "pi-adversarial-chain-parent-"));
    repos.push(snapshotParent);
    const destination = path.join(snapshotParent, "snapshot");
    await mkdir(destination);
    const externalPath = path.join(snapshotParent, "outside-secret");
    await writeFile(externalPath, "outside through chained link\n");

    await expect(extractRangeSnapshot(root, toSha, destination)).rejects.toThrow(
      "Git symlink graph escapes the snapshot",
    );
    await expect(readFile(path.join(destination, "x"), "utf8")).rejects.toThrow();
    await expect(lstat(path.join(destination, "dir", "a"))).rejects.toThrow();
    expect(await readFile(externalPath, "utf8")).toBe("outside through chained link\n");
  });

  it("keeps a safe multi-link chain after component-by-component expansion", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "inside.txt"), "safe chained content\n");
    await mkdir(path.join(root, "dir"));
    await symlink("..", path.join(root, "dir", "a"));
    await symlink("dir/a/inside.txt", path.join(root, "x"));
    const toSha = await commitAll(root, "safe symlink chain");
    const destination = await mkdtemp(path.join(tmpdir(), "pi-adversarial-snapshot-"));
    repos.push(destination);

    await extractRangeSnapshot(root, toSha, destination);
    expect(await readFile(path.join(destination, "x"), "utf8")).toBe("safe chained content\n");
  });

  it("allows a finite repeated expansion of the same safe symlink", async () => {
    const root = await initRepo();
    await mkdir(path.join(root, "dir"));
    await writeFile(path.join(root, "dir", "file"), "finite repeated link\n");
    await symlink("dir", path.join(root, "a"));
    await symlink("a/../a/file", path.join(root, "x"));
    const toSha = await commitAll(root, "finite repeated symlink");
    const destination = await mkdtemp(path.join(tmpdir(), "pi-adversarial-snapshot-"));
    repos.push(destination);

    await extractRangeSnapshot(root, toSha, destination);
    expect(await readFile(path.join(destination, "x"), "utf8")).toBe("finite repeated link\n");
  });

  it("uses case-insensitive Windows graph lookup to reject a chained escape", async () => {
    const root = await initRepo();
    await mkdir(path.join(root, "Dir"));
    await symlink("..", path.join(root, "Dir", "A"));
    await symlink("dir/a/../outside-secret", path.join(root, "x"));
    const toSha = await commitAll(root, "case-insensitive chained escape");
    const snapshotParent = await mkdtemp(path.join(tmpdir(), "pi-adversarial-case-parent-"));
    repos.push(snapshotParent);
    const destination = path.join(snapshotParent, "snapshot");
    await mkdir(destination);
    const externalPath = path.join(snapshotParent, "outside-secret");
    await writeFile(externalPath, "case-insensitive escape\n");

    await expect(extractRangeSnapshot(root, toSha, destination)).rejects.toThrow(
      "Git symlink graph escapes the snapshot",
    );
    await expect(readFile(path.join(destination, "x"), "utf8")).rejects.toThrow();
    await expect(lstat(path.join(destination, "Dir", "A"))).rejects.toThrow();
    expect(await readFile(externalPath, "utf8")).toBe("case-insensitive escape\n");
  });

  it("uses Unicode case folding in the conservative Windows graph lookup", async () => {
    const root = await initRepo();
    await mkdir(path.join(root, "Dir"));
    await symlink("..", path.join(root, "Dir", "Ä"));
    await symlink("dir/ä/../outside-secret", path.join(root, "x"));
    const toSha = await commitAll(root, "Unicode case chained escape");
    const snapshotParent = await mkdtemp(path.join(tmpdir(), "pi-adversarial-unicode-parent-"));
    repos.push(snapshotParent);
    const destination = path.join(snapshotParent, "snapshot");
    await mkdir(destination);
    const externalPath = path.join(snapshotParent, "outside-secret");
    await writeFile(externalPath, "Unicode case escape\n");

    await expect(extractRangeSnapshot(root, toSha, destination)).rejects.toThrow(
      "Git symlink graph escapes the snapshot",
    );
    await expect(lstat(path.join(destination, "Dir", "Ä"))).rejects.toThrow();
    expect(await readFile(externalPath, "utf8")).toBe("Unicode case escape\n");
  });

  it("rejects symlink paths with canonically ambiguous Unicode spellings", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "inside.txt"), "inside\n");
    await symlink("inside.txt", path.join(root, "é"));
    await symlink("inside.txt", path.join(root, "e\u0301"));
    const toSha = await commitAll(root, "ambiguous canonical links");
    const destination = await mkdtemp(path.join(tmpdir(), "pi-adversarial-snapshot-"));
    repos.push(destination);

    await expect(extractRangeSnapshot(root, toSha, destination)).rejects.toThrow(
      "Git symlink paths are ambiguous under platform path rules",
    );
    await expect(lstat(path.join(destination, "é"))).rejects.toThrow();
    await expect(lstat(path.join(destination, "e\u0301"))).rejects.toThrow();
  });

  it("preserves a legal POSIX Unicode symlink target byte-for-byte", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "目标-Ä.txt"), "Unicode target\n");
    await mkdir(path.join(root, "nested"));
    const rawTarget = "../目标-Ä.txt";
    await symlink(rawTarget, path.join(root, "nested", "链接"));
    const toSha = await commitAll(root, "legal POSIX Unicode link");
    const destination = await mkdtemp(path.join(tmpdir(), "pi-adversarial-snapshot-"));
    repos.push(destination);

    await extractRangeSnapshot(root, toSha, destination);
    expect(await readlink(path.join(destination, "nested", "链接"))).toBe(rawTarget);
    expect(await readFile(path.join(destination, "nested", "链接"), "utf8"))
      .toBe("Unicode target\n");
  });

  it("rejects symlink paths that differ only by Windows ASCII case", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "inside.txt"), "inside\n");
    await symlink("inside.txt", path.join(root, "A"));
    await symlink("inside.txt", path.join(root, "a"));
    const toSha = await commitAll(root, "ambiguous case links");
    const destination = await mkdtemp(path.join(tmpdir(), "pi-adversarial-snapshot-"));
    repos.push(destination);

    await expect(extractRangeSnapshot(root, toSha, destination)).rejects.toThrow(
      "Git symlink paths are ambiguous under platform path rules",
    );
    await expect(lstat(path.join(destination, "A"))).rejects.toThrow();
    await expect(lstat(path.join(destination, "a"))).rejects.toThrow();
  });

  it("rejects cyclic and over-deep symlink graphs before materialization", async () => {
    const cyclicRoot = await initRepo();
    await symlink("b", path.join(cyclicRoot, "a"));
    await symlink("a", path.join(cyclicRoot, "b"));
    const cyclicSha = await commitAll(cyclicRoot, "cyclic links");
    const cyclicDestination = await mkdtemp(path.join(tmpdir(), "pi-adversarial-snapshot-"));
    repos.push(cyclicDestination);
    await expect(extractRangeSnapshot(cyclicRoot, cyclicSha, cyclicDestination)).rejects.toThrow(
      "Git symlink graph contains a cycle",
    );
    await expect(lstat(path.join(cyclicDestination, "a"))).rejects.toThrow();

    const deepRoot = await initRepo();
    for (let index = 0; index <= 40; index++) {
      const target = index === 40 ? "inside.txt" : `link-${index + 1}`;
      await symlink(target, path.join(deepRoot, `link-${index}`));
    }
    await writeFile(path.join(deepRoot, "inside.txt"), "inside\n");
    const deepSha = await commitAll(deepRoot, "deep links");
    const deepDestination = await mkdtemp(path.join(tmpdir(), "pi-adversarial-snapshot-"));
    repos.push(deepDestination);
    await expect(extractRangeSnapshot(deepRoot, deepSha, deepDestination)).rejects.toThrow(
      "Git symlink graph exceeds 40 expansions",
    );
    await expect(lstat(path.join(deepDestination, "link-0"))).rejects.toThrow();
  });

  it("does not expose an external file through a chain ending in a rejected symlink", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "base.txt"), "base\n");
    await commitAll(root, "symlink chain base");
    const externalPath = path.join(path.dirname(root), `outside-${randomUUID()}`);
    repos.push(externalPath);
    await writeFile(externalPath, "external secret\n");
    await symlink("z-escape", path.join(root, "a-chain"));
    await symlink(`../${path.basename(externalPath)}`, path.join(root, "z-escape"));
    const toSha = await commitAll(root, "escaping symlink chain");
    const destination = await mkdtemp(path.join(tmpdir(), "pi-adversarial-snapshot-"));
    repos.push(destination);

    await expect(extractRangeSnapshot(root, toSha, destination)).rejects.toThrow(
      "Git symlink graph escapes the snapshot",
    );
    await expect(readFile(path.join(destination, "a-chain"), "utf8")).rejects.toThrow();
    expect(await readFile(externalPath, "utf8")).toBe("external secret\n");
  });

  it("fails loud on a non-UTF-8 symlink target and cleans the partial workspace", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "base.txt"), "base\n");
    const fromSha = await commitAll(root, "symlink base");
    const rawTarget = Buffer.from([0x74, 0x61, 0x72, 0x67, 0x65, 0x74, 0x2d, 0xff]);
    await symlink(rawTarget, path.join(root, "raw-link"));
    const toSha = await commitAll(root, "raw symlink target");
    let workspacePath: string | undefined;
    workspaceHooks.onCreated = (workspace) => { workspacePath = workspace.runDir; };

    await expect(prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "range", fromRef: fromSha, toRef: toSha },
      runId: randomUUID(),
    })).rejects.toThrow("Git symlink target must be valid UTF-8");

    expect(workspacePath).toBeDefined();
    await expect(access(workspacePath!)).rejects.toThrow();
  });

  it("aborts before a range snapshot finishes and cleans the partial workspace", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "base.txt"), "base\n");
    const fromSha = await commitAll(root, "abort base");
    await writeFile(path.join(root, "changed.txt"), "changed\n");
    const toSha = await commitAll(root, "abort target");
    const controller = new AbortController();
    const reason = new Error("test freeze cancellation");
    let workspacePath: string | undefined;
    workspaceHooks.onCreated = (workspace) => {
      workspacePath = workspace.runDir;
      controller.abort(reason);
    };

    await expect(prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "range", fromRef: fromSha, toRef: toSha },
      runId: randomUUID(),
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(workspacePath).toBeDefined();
    await expect(access(workspacePath!)).rejects.toThrow();
  });

  it("classifies an abort whose partial workspace cleanup fails", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "base.txt"), "base\n");
    const fromSha = await commitAll(root, "cleanup failure base");
    await writeFile(path.join(root, "changed.txt"), "changed\n");
    const toSha = await commitAll(root, "cleanup failure target");
    const controller = new AbortController();
    const reason = new Error("test freeze abort before failed cleanup");
    const cleanupFailure = new Error("simulated workspace cleanup failure");
    let workspacePath: string | undefined;
    let fixtureCleanup: (() => Promise<void>) | undefined;
    workspaceHooks.onCreated = (workspace) => {
      workspacePath = workspace.runDir;
      fixtureCleanup = workspace.cleanup;
      workspace.cleanup = async () => { throw cleanupFailure; };
      controller.abort(reason);
    };

    try {
      const error = await prepareFrozenReviewInput({
        cwd: root,
        target: { mode: "range", fromRef: fromSha, toRef: toSha },
        runId: randomUUID(),
        signal: controller.signal,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ReviewInputCleanupError);
      expect(error).not.toBe(reason);
      expect((error as ReviewInputCleanupError).freezeError).toBe(reason);
      expect((error as ReviewInputCleanupError).cleanupError).toBe(cleanupFailure);
      expect((error as Error).message).toContain(
        "input freeze failed and temporary workspace cleanup also failed",
      );
      expect(workspacePath).toBeDefined();
      await expect(access(workspacePath!)).resolves.toBeUndefined();
    } finally {
      await fixtureCleanup?.();
      if (workspacePath) await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("ignores Git replace refs when freezing the requested commit and blobs", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "value.txt"), "before\n");
    const fromSha = await commitAll(root, "before replacement target");
    await writeFile(path.join(root, "value.txt"), "original committed value\n");
    const toSha = await commitAll(root, "target value");
    const originalBlob = await git(root, "rev-parse", `${toSha}:value.txt`);
    const replacementFile = path.join(root, ".git", "replacement-content");
    await writeFile(replacementFile, "forged replacement value\n");
    const replacementBlob = await git(root, "hash-object", "-w", replacementFile);
    await git(root, "replace", originalBlob, replacementBlob);

    const frozen = await prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "range", fromRef: fromSha, toRef: toSha },
      runId: randomUUID(),
    });
    try {
      expect(await readFile(path.join(frozen.reviewerCwd, "value.txt"), "utf8"))
        .toBe("original committed value\n");
      expect(await readFile(frozen.inputPath, "utf8")).toContain("original committed value");
      expect(await readFile(frozen.inputPath, "utf8")).not.toContain("forged replacement value");
    } finally {
      await frozen.cleanup();
    }
  });

  it("extracts committed LFS pointers without running configured smudge filters", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, ".gitattributes"), "*.lfs filter=demo\n");
    await git(root, "config", "filter.demo.clean", "cat");
    await git(root, "config", "filter.demo.smudge", "sed s/version/SMUDGED/");
    const fromSha = await commitAll(root, "attributes");
    const pointer = [
      "version https://git-lfs.github.com/spec/v1",
      "oid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "size 123",
      "",
    ].join("\n");
    await writeFile(path.join(root, "asset.lfs"), pointer);
    const toSha = await commitAll(root, "add lfs pointer");
    const before = await git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all");

    const frozen = await prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "range", fromRef: fromSha, toRef: toSha },
      runId: randomUUID(),
    });
    try {
      expect(await readFile(path.join(frozen.reviewerCwd, "asset.lfs"), "utf8")).toBe(pointer);
      expect(frozen.limitedContext).toContain(
        "Git LFS object content is not materialized; only the committed pointer is available.",
      );
    } finally {
      await frozen.cleanup();
    }
    expect(await git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all"))
      .toBe(before);

    await git(root, "mv", "asset.lfs", "renamed-asset.lfs");
    const renamedSha = await commitAll(root, "rename lfs pointer only");
    const renamed = await prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "range", fromRef: toSha, toRef: renamedSha },
      runId: randomUUID(),
    });
    try {
      expect(renamed.limitedContext).toContain(
        "Git LFS object content is not materialized; only the committed pointer is available.",
      );
    } finally {
      await renamed.cleanup();
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

  it("marks range submodules limited and materializes only an empty gitlink directory", async () => {
    const source = await initRepo();
    await writeFile(path.join(source, "sub.txt"), "submodule content\n");
    await commitAll(source, "submodule base");

    const root = await initRepo();
    await writeFile(path.join(root, "root.txt"), "root\n");
    const fromSha = await commitAll(root, "root base");
    await exec("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "vendor/sub"], {
      cwd: root,
    });
    const toSha = await commitAll(root, "add range submodule");

    const frozen = await prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "range", fromRef: fromSha, toRef: toSha },
      runId: randomUUID(),
    });
    try {
      expect(frozen.limitedContext).toContain(
        "Git submodule object content is not embedded in the frozen review context.",
      );
      expect(await readdir(path.join(frozen.reviewerCwd, "vendor/sub"))).toEqual([]);
    } finally {
      await frozen.cleanup();
    }

    await writeFile(path.join(root, "root.txt"), "root changed while gitlink stays fixed\n");
    const nextSha = await commitAll(root, "change root only");
    const unchangedGitlink = await prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "range", fromRef: toSha, toRef: nextSha },
      runId: randomUUID(),
    });
    try {
      expect(unchangedGitlink.limitedContext).toContain(
        "Git submodule object content is not embedded in the frozen review context.",
      );
      expect(await readdir(path.join(unchangedGitlink.reviewerCwd, "vendor/sub"))).toEqual([]);
    } finally {
      await unchangedGitlink.cleanup();
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
    const oversizedStatus = await git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all");

    const oversizedGitError = await prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "local" },
      runId: randomUUID(),
      maxBytes: 1_024,
      maxLines: 5_000,
    }).catch((error: unknown) => error);
    expect(oversizedGitError).toBeInstanceOf(OversizedReviewInputError);
    expect((oversizedGitError as Error).message).toContain("exceeds the 1024-byte limit");
    expect((oversizedGitError as Error).message).not.toContain("lines");
    expect(await git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all"))
      .toBe(oversizedStatus);

    await writeFile(path.join(root, "tracked.txt"), "base\nsmall\n");
    await writeFile(path.join(root, "requirements.md"), "r".repeat(4_096));
    await commitAll(root, "add large requirement");
    await appendFile(path.join(root, "tracked.txt"), "review change\n");
    const reqdocStatus = await git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all");
    const oversizedRequirementError = await prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "local" },
      reqdoc: "requirements.md",
      runId: randomUUID(),
      maxBytes: 2_048,
      maxLines: 5_000,
    }).catch((error: unknown) => error);
    expect(oversizedRequirementError).toBeInstanceOf(OversizedReviewInputError);
    expect((oversizedRequirementError as Error).message).toBe(
      "Frozen requirement document exceeds the 2048-byte limit (4096 bytes). " +
        "Reduce or split the requirement document.",
    );
    expect(await git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all"))
      .toBe(reqdocStatus);
  });

  it("suggests independently bounded committed ranges for an oversized target", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "base.txt"), "base\n");
    const baseSha = await commitAll(root, "base");
    const commits: string[] = [];
    for (let index = 1; index <= 3; index++) {
      await writeFile(path.join(root, `part-${index}.txt`), `${"x".repeat(70 * 1024)}\n`);
      commits.push(await commitAll(root, `part ${index}`));
    }

    const error = await fingerprintReviewTarget({
      cwd: root,
      target: { mode: "base", baseRef: baseSha },
      maxBytes: RECOMMENDED_FROZEN_INPUT_BYTES,
      maxLines: RECOMMENDED_FROZEN_INPUT_LINES,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OversizedReviewInputError);
    const suggestions = (error as OversizedReviewInputError).rangeSuggestions;
    expect(suggestions).toEqual([
      `--range ${baseSha}..${commits[1]}`,
      `--range ${commits[1]}..${commits[2]}`,
    ]);
    for (const suggestion of suggestions) {
      const range = /--range ([0-9a-f]+)\.\.([0-9a-f]+)$/u.exec(suggestion);
      expect(range).not.toBeNull();
      const frozen = await prepareFrozenReviewInput({
        cwd: root,
        target: { mode: "range", fromRef: range![1]!, toRef: range![2]! },
        runId: randomUUID(),
        maxBytes: RECOMMENDED_FROZEN_INPUT_BYTES,
        maxLines: RECOMMENDED_FROZEN_INPUT_LINES,
      });
      await frozen.cleanup();
    }
    expect((error as Error).message).toContain("Suggested smaller review ranges");
    expect((error as Error).message).toContain("review any uncommitted changes separately");
    expect((error as Error).message).not.toContain("lines");
  });

  it("sizes suggested ranges with the frozen requirement context included", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "base.txt"), "base\n");
    await writeFile(path.join(root, "requirements.md"), `${"r".repeat(90 * 1024)}\n`);
    const baseSha = await commitAll(root, "base with requirements");
    const commits: string[] = [];
    for (let index = 1; index <= 3; index++) {
      await writeFile(path.join(root, `context-part-${index}.txt`), `${"x".repeat(60 * 1024)}\n`);
      commits.push(await commitAll(root, `context part ${index}`));
    }

    const error = await prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "base", baseRef: baseSha },
      reqdoc: "requirements.md",
      runId: randomUUID(),
      maxBytes: RECOMMENDED_FROZEN_INPUT_BYTES,
      maxLines: RECOMMENDED_FROZEN_INPUT_LINES,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OversizedReviewInputError);
    expect((error as OversizedReviewInputError).rangeSuggestions).toEqual([
      `--range ${baseSha}..${commits[0]}`,
      `--range ${commits[0]}..${commits[1]}`,
      `--range ${commits[1]}..${commits[2]}`,
    ]);
    expect((error as Error).message).toContain(
      "replace only the original target and keep all other options",
    );
  });

  it("skips empty commit ranges and does not suggest an oversized single commit", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "base.txt"), "base\n");
    const baseSha = await commitAll(root, "base");
    await git(root, "commit", "--allow-empty", "-qm", "empty commit");
    const emptySha = await git(root, "rev-parse", "HEAD");
    await writeFile(path.join(root, "oversized.txt"), `${"x".repeat(210 * 1024)}\n`);
    const oversizedSha = await commitAll(root, "oversized commit");

    const error = await fingerprintReviewTarget({
      cwd: root,
      target: { mode: "base", baseRef: baseSha },
      maxBytes: RECOMMENDED_FROZEN_INPUT_BYTES,
      maxLines: RECOMMENDED_FROZEN_INPUT_LINES,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OversizedReviewInputError);
    expect((error as OversizedReviewInputError).rangeSuggestions).toEqual([]);
    expect((error as Error).message).not.toContain(emptySha.slice(0, 12));
    expect((error as Error).message).toContain(
      `Single-commit ranges still over the limit: ${oversizedSha.slice(0, 12)}`,
    );
    expect((error as Error).message).toContain("split those commits before review");
  });

  it("keeps range suggestions bound to resolved SHAs after a ref moves", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "base.txt"), "base\n");
    const baseSha = await commitAll(root, "base");
    const oldCommits: string[] = [];
    for (let index = 1; index <= 3; index++) {
      await writeFile(path.join(root, `old-${index}.txt`), `${"x".repeat(70 * 1024)}\n`);
      oldCommits.push(await commitAll(root, `old part ${index}`));
    }
    await git(root, "branch", "topic", oldCommits[2]);
    const request = { mode: "range" as const, fromRef: baseSha, toRef: "topic" };
    const resolvedTarget = await resolveReviewTarget(root, request);

    await git(root, "checkout", "-qb", "replacement", baseSha);
    await writeFile(path.join(root, "replacement.txt"), "small replacement\n");
    const replacementSha = await commitAll(root, "replacement");
    await git(root, "branch", "-f", "topic", replacementSha);

    const suggestions = await suggestReviewRanges({
      root,
      target: request,
      resolvedTarget,
      maxBytes: RECOMMENDED_FROZEN_INPUT_BYTES,
      maxLines: RECOMMENDED_FROZEN_INPUT_LINES,
    });

    expect(suggestions.commands).toEqual([
      `--range ${baseSha}..${oldCommits[1]}`,
      `--range ${oldCommits[1]}..${oldCommits[2]}`,
    ]);
    expect(suggestions.commands.join("\n")).not.toContain(replacementSha);
  });

  it("fails loud on non-UTF-8 Git paths instead of aliasing snapshot names", async () => {
    const root = await initRepo();
    await writeFile(path.join(root, "base.txt"), "base\n");
    const fromSha = await commitAll(root, "utf8 base");
    const invalidPath = Buffer.concat([
      Buffer.from(`${root}${path.sep}bad-`),
      Buffer.from([0xff]),
      Buffer.from(".txt"),
    ]);
    await writeFile(invalidPath, "invalid path bytes\n");
    const toSha = await commitAll(root, "non utf8 path");

    await expect(prepareFrozenReviewInput({
      cwd: root,
      target: { mode: "range", fromRef: fromSha, toRef: toSha },
      runId: randomUUID(),
    })).rejects.toThrow("Git paths must be valid UTF-8");
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
  it("accepts exact byte/line limits and reports only exceeded dimensions", () => {
    expect(assertFrozenInputWithinLimits("a\nb\n", 4, 2)).toEqual({ bytes: 4, lines: 2 });

    const capture = (content: string, maxBytes: number, maxLines: number) => {
      try {
        assertFrozenInputWithinLimits(content, maxBytes, maxLines);
        throw new Error("Expected frozen input to exceed a limit.");
      } catch (error) {
        expect(error).toBeInstanceOf(OversizedReviewInputError);
        return error as OversizedReviewInputError;
      }
    };
    expect(capture("a\nb\n!", 4, 3).message).toBe(
      "Frozen review input exceeds the 4-byte limit (5 bytes). Split the review target.",
    );
    expect(capture("a\nb\nc", 5, 2).message).toBe(
      "Frozen review input exceeds the 2-line limit (3 lines). Split the review target.",
    );
    expect(capture("a\nb\nc", 4, 2).message).toBe(
      "Frozen review input exceeds its limits: 4-byte limit (5 bytes); " +
        "2-line limit (3 lines). Split the review target.",
    );
  });

  it("keeps the 200 KiB / 5000-line recommendation below the absolute limits", () => {
    expect(RECOMMENDED_FROZEN_INPUT_BYTES).toBe(200 * 1024);
    expect(RECOMMENDED_FROZEN_INPUT_LINES).toBe(5_000);
    expect(MAX_FROZEN_INPUT_BYTES).toBe(1024 * 1024);
    expect(MAX_FROZEN_INPUT_LINES).toBe(25_000);
  });

  it("enforces the absolute 1 MiB and 25000-line boundaries exactly", () => {
    const exactBytes = "x".repeat(MAX_FROZEN_INPUT_BYTES);
    expect(assertFrozenInputWithinLimits(
      exactBytes,
      MAX_FROZEN_INPUT_BYTES,
      MAX_FROZEN_INPUT_LINES,
    ).bytes).toBe(MAX_FROZEN_INPUT_BYTES);
    expect(() => assertFrozenInputWithinLimits(
      `${exactBytes}x`,
      MAX_FROZEN_INPUT_BYTES,
      MAX_FROZEN_INPUT_LINES,
    )).toThrow(OversizedReviewInputError);

    const exactLines = Array.from({ length: MAX_FROZEN_INPUT_LINES }, () => "x").join("\n");
    expect(assertFrozenInputWithinLimits(
      exactLines,
      MAX_FROZEN_INPUT_BYTES,
      MAX_FROZEN_INPUT_LINES,
    ).lines).toBe(MAX_FROZEN_INPUT_LINES);
    expect(() => assertFrozenInputWithinLimits(
      `${exactLines}\nx`,
      MAX_FROZEN_INPUT_BYTES,
      MAX_FROZEN_INPUT_LINES,
    )).toThrow(OversizedReviewInputError);
  });

  it("measures UTF-8 bytes independently from logical lines", () => {
    expect(measureFrozenInput("你\n好")).toEqual({ bytes: 7, lines: 2 });
  });
});
