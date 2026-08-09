import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  choosePreferredRemote,
  fetchReviewRemote,
  inspectGitPreflight,
  remotesReferencedByTarget,
  spawnPreflightCommand,
  type PreflightCommandRunner,
} from "../src/preflight/git-preflight.ts";

const exec = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd });
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

async function featureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-preflight-"));
  roots.push(root);
  const remote = path.join(root, "fork.git");
  const repo = path.join(root, "repo");
  await exec("git", ["init", "--bare", "--initial-branch=main", remote]);
  await exec("git", ["init", "--initial-branch=main", repo]);
  await git(repo, "config", "user.email", "review@example.test");
  await git(repo, "config", "user.name", "Review Test");
  await writeFile(path.join(repo, "tracked.ts"), "export const value = 1;\n");
  await git(repo, "add", "tracked.ts");
  await git(repo, "commit", "-m", "base");
  await git(repo, "remote", "add", "fork", remote);
  await git(repo, "push", "-u", "fork", "main");
  await git(repo, "switch", "-c", "feature/preflight");
  await writeFile(path.join(repo, "feature.ts"), "export const feature = true;\n");
  await git(repo, "add", "feature.ts");
  await git(repo, "commit", "-m", "feature");
  await git(repo, "push", "-u", "fork", "feature/preflight");
  await writeFile(path.join(repo, "tracked.ts"), "export const value = 2;\n");
  await git(repo, "add", "tracked.ts");
  await writeFile(path.join(repo, "tracked.ts"), "export const value = 3;\n");
  await writeFile(path.join(repo, "untracked.ts"), "export const untracked = true;\n");
  return repo;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Git adversarial-review preflight", () => {
  it("prefers branch upstream, discovers remote main, and classifies branch plus local state", async () => {
    const repo = await featureRepo();

    await expect(fetchReviewRemote(repo, "fork")).resolves.toEqual({
      status: "succeeded",
      remote: "fork",
      timedOut: false,
    });
    const state = await inspectGitPreflight(repo);

    expect(state).toMatchObject({
      root: repo,
      branch: "feature/preflight",
      remotes: ["fork"],
      upstreamRef: "fork/feature/preflight",
      upstreamRemote: "fork",
      preferredRemote: "fork",
      remoteAmbiguous: false,
      defaultBranch: "main",
      defaultBranchRef: "fork/main",
      ahead: 1,
      behind: 0,
      relationAvailable: true,
      workingTree: {
        staged: true,
        unstaged: true,
        untracked: true,
        unmerged: false,
      },
    });
    expect(state.statusSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(state.defaultBranchSha).toMatch(/^[0-9a-f]{40}$/u);
    await writeFile(path.join(repo, "another-untracked.ts"), "export const another = true;\n");
    const changed = await inspectGitPreflight(repo);
    expect(changed.statusSha256).not.toBe(state.statusSha256);
  });

  it("never executes configured clean filters while inspecting dirty state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-review-inspect-filter-"));
    roots.push(root);
    await exec("git", ["init", "--initial-branch=main", root]);
    await git(root, "config", "user.email", "review@example.test");
    await git(root, "config", "user.name", "Review Test");
    await writeFile(path.join(root, ".gitattributes"), "*.ts filter=evil\n");
    await writeFile(path.join(root, "file.ts"), "export const value = 1;\n");
    await git(root, "add", ".gitattributes", "file.ts");
    await git(root, "commit", "-m", "base");
    const marker = path.join(root, "filter-ran");
    const filter = path.join(root, "filter.sh");
    await writeFile(filter, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncat\n`);
    await chmod(filter, 0o700);
    await git(root, "config", "filter.evil.clean", filter);
    await writeFile(path.join(root, "file.ts"), "export const value = 2;\n");

    await expect(inspectGitPreflight(root)).resolves.toMatchObject({
      workingTree: { unstaged: true },
    });
    expect(await exists(marker)).toBe(false);
  });

  it("disables repository hooks during a successful automatic fetch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-review-fetch-hooks-"));
    roots.push(root);
    const remote = path.join(root, "remote.git");
    const producer = path.join(root, "producer");
    const consumer = path.join(root, "consumer");
    await exec("git", ["init", "--bare", "--initial-branch=main", remote]);
    await exec("git", ["init", "--initial-branch=main", producer]);
    await git(producer, "config", "user.email", "review@example.test");
    await git(producer, "config", "user.name", "Review Test");
    await writeFile(path.join(producer, "file.ts"), "export const value = 1;\n");
    await git(producer, "add", "file.ts");
    await git(producer, "commit", "-m", "base");
    await git(producer, "remote", "add", "origin", remote);
    await git(producer, "push", "-u", "origin", "main");
    await exec("git", ["clone", "--quiet", remote, consumer]);

    const marker = path.join(root, "hook-ran");
    const maliciousUploadpack = path.join(root, "malicious-uploadpack.sh");
    await writeFile(
      maliciousUploadpack,
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`,
    );
    await chmod(maliciousUploadpack, 0o700);
    await git(remote, "config", "uploadpack.packObjectsHook", maliciousUploadpack);
    await git(consumer, "config", "remote.origin.uploadpack", maliciousUploadpack);
    const hook = path.join(consumer, ".git", "hooks", "reference-transaction");
    await writeFile(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`);
    await chmod(hook, 0o700);
    await writeFile(path.join(producer, "file.ts"), "export const value = 2;\n");
    await git(producer, "add", "file.ts");
    await git(producer, "commit", "-m", "remote update");
    await git(producer, "push", "origin", "main");

    await expect(fetchReviewRemote(consumer, "origin")).resolves.toMatchObject({ status: "succeeded" });
    expect(await exists(marker)).toBe(false);
    expect(await git(consumer, "rev-parse", "origin/main")).toBe(await git(producer, "rev-parse", "HEAD"));
  });

  it("does not execute repository SSH commands, askpass helpers, or external transport helpers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-review-fetch-safety-"));
    roots.push(root);
    await exec("git", ["init", "--initial-branch=main", root]);
    await git(root, "config", "user.email", "review@example.test");
    await git(root, "config", "user.name", "Review Test");
    await writeFile(path.join(root, "file.ts"), "export const value = 1;\n");
    await git(root, "add", "file.ts");
    await git(root, "commit", "-m", "base");

    const marker = path.join(root, "command-ran");
    const malicious = path.join(root, "malicious.sh");
    await writeFile(malicious, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
    await chmod(malicious, 0o700);
    await git(root, "config", "core.sshCommand", malicious);
    await git(root, "config", "core.askPass", malicious);
    await git(root, "config", "credential.helper", `!${malicious}`);
    await git(root, "remote", "add", "origin", "ssh://127.0.0.1:1/repository");
    const injected = {
      GIT_SSH_COMMAND: malicious,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.sshCommand",
      GIT_CONFIG_VALUE_0: malicious,
    };
    const previous = new Map(Object.keys(injected).map((key) => [key, process.env[key]]));
    Object.assign(process.env, injected);
    try {
      await expect(fetchReviewRemote(root, "origin", { timeoutMs: 5_000 })).resolves.toMatchObject({
        status: "failed",
      });
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(await exists(marker)).toBe(false);

    const bin = path.join(root, "bin");
    await mkdir(bin);
    const helper = path.join(bin, "git-remote-evil");
    const sshHelper = path.join(bin, "git-remote-ssh");
    const helperScript = `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`;
    await writeFile(helper, helperScript);
    await writeFile(sshHelper, helperScript);
    await chmod(helper, 0o700);
    await chmod(sshHelper, 0o700);
    await git(root, "remote", "set-url", "origin", "evil::payload");
    const previousPath = process.env.PATH;
    const previousExecPath = process.env.GIT_EXEC_PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    process.env.GIT_EXEC_PATH = bin;
    try {
      await expect(fetchReviewRemote(root, "origin", { timeoutMs: 5_000 })).resolves.toMatchObject({
        status: "failed",
      });
      await git(root, "remote", "set-url", "origin", ".");
      await git(root, "config", "remote.origin.vcs", "ssh");
      await expect(fetchReviewRemote(root, "origin", { timeoutMs: 5_000 })).resolves.toMatchObject({
        status: "succeeded",
      });
    } finally {
      process.env.PATH = previousPath;
      if (previousExecPath === undefined) delete process.env.GIT_EXEC_PATH;
      else process.env.GIT_EXEC_PATH = previousExecPath;
    }
    expect(await exists(marker)).toBe(false);
  });

  it("kills a SIGTERM-ignoring descendant before resolving cancellation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-review-process-group-"));
    roots.push(root);
    const script = path.join(root, "parent.sh");
    const pidFile = path.join(root, "child.pid");
    await writeFile(script, `#!/bin/sh\npidfile="$1"\nsh -c 'trap "" TERM; echo $$ > "$1"; while :; do sleep 1; done' child "$pidfile" &\ntrap 'exit 0' TERM\nwait\n`);
    await chmod(script, 0o700);
    const controller = new AbortController();
    const running = spawnPreflightCommand(script, [pidFile], {
      cwd: root,
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    await vi.waitFor(async () => expect(await exists(pidFile)).toBe(true));
    const childPid = Number((await readFile(pidFile, "utf8")).trim());
    try {
      controller.abort(new Error("cancel process group"));
      await expect(running).resolves.toMatchObject({ aborted: true, killed: true });
      await vi.waitFor(() => expect(processAlive(childPid)).toBe(false), { timeout: 2_000 });
    } finally {
      if (processAlive(childPid)) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });

  it("treats a repository without upstream or remotes as an inspectable ambiguous state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-review-no-remote-"));
    roots.push(root);
    await exec("git", ["init", "--initial-branch=topic", root]);
    await git(root, "config", "user.email", "review@example.test");
    await git(root, "config", "user.name", "Review Test");
    await writeFile(path.join(root, "file.ts"), "export const value = 1;\n");
    await git(root, "add", "file.ts");
    await git(root, "commit", "-m", "base");

    await expect(inspectGitPreflight(root)).resolves.toMatchObject({
      branch: "topic",
      remotes: [],
      remoteAmbiguous: false,
      relationAvailable: false,
    });
  });

  it("does not guess when main and master both exist without remote HEAD", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-review-default-ambiguous-"));
    roots.push(root);
    await exec("git", ["init", "--initial-branch=topic", root]);
    await git(root, "config", "user.email", "review@example.test");
    await git(root, "config", "user.name", "Review Test");
    await writeFile(path.join(root, "file.ts"), "export const value = 1;\n");
    await git(root, "add", "file.ts");
    await git(root, "commit", "-m", "base");
    await git(root, "remote", "add", "origin", ".");
    await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    await git(root, "update-ref", "refs/remotes/origin/master", "HEAD");
    await git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/missing");

    await expect(inspectGitPreflight(root)).resolves.toMatchObject({
      preferredRemote: "origin",
      defaultBranchCandidates: ["origin/main", "origin/master"],
      defaultBranchAmbiguous: true,
      relationAvailable: false,
    });
  });

  it("uses upstream, then origin, then a sole remote and marks multiple unnamed remotes ambiguous", () => {
    expect(choosePreferredRemote(["origin", "upstream"], "upstream")).toEqual({
      remote: "upstream",
      ambiguous: false,
    });
    expect(choosePreferredRemote(["fork", "origin"])).toEqual({ remote: "origin", ambiguous: false });
    expect(choosePreferredRemote(["fork"])).toEqual({ remote: "fork", ambiguous: false });
    expect(choosePreferredRemote(["fork", "company"])).toEqual({ ambiguous: true });
  });

  it("maps explicit remote-tracking refs to the remotes that must be fetched", () => {
    expect(remotesReferencedByTarget(
      { mode: "range", fromRef: "upstream/main", toRef: "origin/feature" },
      ["origin", "upstream"],
    )).toEqual(["origin", "upstream"]);
    expect(remotesReferencedByTarget(
      { mode: "range", fromRef: "refs/remotes/upstream/main", toRef: "remotes/origin/feature" },
      ["origin", "upstream"],
    )).toEqual(["origin", "upstream"]);
    expect(remotesReferencedByTarget({ mode: "base", baseRef: "HEAD~2" }, ["origin"]))
      .toEqual([]);
  });

  it("returns bounded fetch failure metadata without exposing stderr", async () => {
    const runner: PreflightCommandRunner = vi.fn(async () => ({
      stdout: "",
      stderr: "https://token@example.test/private.git: denied",
      code: 1,
      killed: false,
      timedOut: false,
      aborted: false,
    }));

    await expect(fetchReviewRemote("/repo", "origin", { runner })).resolves.toEqual({
      status: "failed",
      remote: "origin",
      timedOut: false,
    });
  });

  it("distinguishes timeout and respects cancellation before fetch", async () => {
    const timedOut: PreflightCommandRunner = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      code: 1,
      killed: true,
      timedOut: true,
      aborted: false,
    }));
    await expect(fetchReviewRemote("/repo", "origin", { runner: timedOut })).resolves.toMatchObject({
      status: "failed",
      timedOut: true,
    });

    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));
    const runner = vi.fn<PreflightCommandRunner>();
    await expect(fetchReviewRemote("/repo", "origin", {
      runner,
      signal: controller.signal,
    })).rejects.toThrow("cancelled by test");
    expect(runner).not.toHaveBeenCalled();
  });
});
