import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { ReviewInputError } from "../input/errors.ts";
import {
  INHERITED_GIT_CONTEXT_ENV_KEYS,
  neutralizedGitConfigEnv,
} from "../input/git-target.ts";
import type { ReviewTargetRequest } from "../types.ts";

const INSPECT_TIMEOUT_MS = 10_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 60_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const PROCESS_GROUP_GRACE_MS = 350;

export interface PreflightCommandOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  unsetEnv?: readonly string[];
}

export interface PreflightCommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
  timedOut: boolean;
  aborted: boolean;
}

export type PreflightCommandRunner = (
  command: string,
  args: readonly string[],
  options: PreflightCommandOptions,
) => Promise<PreflightCommandResult>;

function withCommandEnvironment(
  runner: PreflightCommandRunner,
  injected: NodeJS.ProcessEnv,
): PreflightCommandRunner {
  return (command, args, options) => runner(command, args, {
    ...options,
    env: { ...options.env, ...injected },
  });
}

function killProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the process group has already gone.
    }
  }
  try { child.kill(signal); } catch { /* process already exited */ }
}

/** Bounded, non-shell executor used by preflight Git inspection and fetch. */
export const spawnPreflightCommand: PreflightCommandRunner = async (
  command,
  args,
  options,
) => await new Promise((resolve) => {
  const env = options.env ? { ...process.env, ...options.env } : { ...process.env };
  for (const key of options.unsetEnv ?? []) delete env[key];
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let killed = false;
  let timedOut = false;
  let aborted = options.signal?.aborted ?? false;
  let settled = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

  const stop = (reason: "timeout" | "abort" | "output") => {
    if (killed) return;
    killed = true;
    timedOut ||= reason === "timeout";
    aborted ||= reason === "abort";
    killProcessTree(child, "SIGTERM");
    forceKillTimer = setTimeout(
      () => killProcessTree(child, "SIGKILL"),
      PROCESS_GROUP_GRACE_MS,
    );
    forceKillTimer.unref?.();
  };
  const collect = (target: Buffer[], chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
      stop("output");
      return;
    }
    target.push(chunk);
  };
  const onAbort = () => stop("abort");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (aborted) stop("abort");
  const timeout = setTimeout(() => stop("timeout"), options.timeoutMs);
  timeout.unref?.();

  child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
  child.on("error", () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    options.signal?.removeEventListener("abort", onAbort);
    resolve({ stdout: "", stderr: "", code: 1, killed, timedOut, aborted });
  });
  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    // The direct Git/sh parent can exit on SIGTERM while a descendant ignores
    // it. Kill the original process group before clearing the grace timer.
    if (killed) killProcessTree(child, "SIGKILL");
    if (forceKillTimer) clearTimeout(forceKillTimer);
    options.signal?.removeEventListener("abort", onAbort);
    resolve({
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      code: code ?? 1,
      killed,
      timedOut,
      aborted,
    });
  });
});

interface GitRunOptions {
  allowedExitCodes?: readonly number[];
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

function abortedError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("Adversarial review preflight cancelled.");
}

function inheritedGitEnvironmentKeys(): string[] {
  return [
    ...INHERITED_GIT_CONTEXT_ENV_KEYS,
    ...Object.keys(process.env).filter((key) => (
      key === "GIT_CONFIG_COUNT" || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)
    )),
  ];
}

async function safeFetchPath(root: string): Promise<string> {
  const canonicalRoot = await realpath(root).catch(() => path.resolve(root));
  const entries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const safe: string[] = [];
  for (const entry of entries) {
    if (!path.isAbsolute(entry)) continue;
    const canonical = await realpath(entry).catch(() => path.resolve(entry));
    const relative = path.relative(canonicalRoot, canonical);
    const insideRepository = relative === "" || (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
    if (!insideRepository) safe.push(entry);
  }
  return safe.join(path.delimiter);
}

async function runGit(
  runner: PreflightCommandRunner,
  root: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<PreflightCommandResult> {
  if (options.signal?.aborted) throw abortedError(options.signal);
  const result = await runner(
    "git",
    ["-c", "core.fsmonitor=false", ...args],
    {
      cwd: root,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? INSPECT_TIMEOUT_MS,
      env: {
        GIT_CONFIG_COUNT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_OPTIONAL_LOCKS: "0",
        ...options.env,
      },
      unsetEnv: [
        ...inheritedGitEnvironmentKeys(),
        "GIT_EXTERNAL_DIFF",
      ],
    },
  );
  if (result.aborted) throw abortedError(options.signal);
  if (result.killed) {
    throw new ReviewInputError("Git inspection timed out during adversarial review preflight.");
  }
  const allowed = new Set(options.allowedExitCodes ?? [0]);
  if (!allowed.has(result.code)) {
    throw new ReviewInputError("Unable to inspect Git state for adversarial review preflight.");
  }
  return result;
}

async function optionalGitOutput(
  runner: PreflightCommandRunner,
  root: string,
  args: readonly string[],
  signal?: AbortSignal,
  allowedExitCodes: readonly number[] = [0, 1],
): Promise<string | undefined> {
  const result = await runGit(runner, root, args, { allowedExitCodes, signal });
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function lines(value: string): string[] {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function upstreamRemote(upstreamRef: string | undefined, remotes: readonly string[]): string | undefined {
  if (!upstreamRef) return undefined;
  return [...remotes]
    .sort((left, right) => right.length - left.length)
    .find((remote) => upstreamRef.startsWith(`${remote}/`));
}

export interface WorkingTreeState {
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  unmerged: boolean;
}

export interface GitPreflightState {
  root: string;
  headSha: string;
  statusSha256: string;
  branch?: string;
  remotes: string[];
  upstreamRef?: string;
  upstreamRemote?: string;
  preferredRemote?: string;
  remoteAmbiguous: boolean;
  defaultBranch?: string;
  defaultBranchRef?: string;
  defaultBranchSha?: string;
  defaultBranchCandidates: string[];
  defaultBranchAmbiguous: boolean;
  ahead?: number;
  behind?: number;
  relationAvailable: boolean;
  workingTree: WorkingTreeState;
  operation?: "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";
  shallow: boolean;
}

export function choosePreferredRemote(
  remotes: readonly string[],
  configuredUpstreamRemote?: string,
): { remote?: string; ambiguous: boolean } {
  if (configuredUpstreamRemote && remotes.includes(configuredUpstreamRemote)) {
    return { remote: configuredUpstreamRemote, ambiguous: false };
  }
  if (remotes.includes("origin")) return { remote: "origin", ambiguous: false };
  if (remotes.length === 1) return { remote: remotes[0], ambiguous: false };
  return { ambiguous: remotes.length > 1 };
}

async function refExists(
  runner: PreflightCommandRunner,
  root: string,
  ref: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await runGit(
    runner,
    root,
    ["show-ref", "--verify", "--quiet", ref],
    { allowedExitCodes: [0, 1], signal },
  );
  return result.code === 0;
}

async function resolveDefaultBranch(
  runner: PreflightCommandRunner,
  root: string,
  remote: string | undefined,
  signal?: AbortSignal,
): Promise<{ branch?: string; ref?: string; candidates: string[]; ambiguous: boolean }> {
  if (!remote) return { candidates: [], ambiguous: false };
  const symbolic = await optionalGitOutput(
    runner,
    root,
    ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
    signal,
  );
  if (
    symbolic?.startsWith(`${remote}/`) &&
    await refExists(runner, root, `refs/remotes/${symbolic}`, signal)
  ) {
    return {
      branch: symbolic.slice(remote.length + 1),
      ref: symbolic,
      candidates: [symbolic],
      ambiguous: false,
    };
  }
  const candidates: string[] = [];
  for (const branch of ["main", "master"]) {
    const fullRef = `refs/remotes/${remote}/${branch}`;
    if (await refExists(runner, root, fullRef, signal)) candidates.push(`${remote}/${branch}`);
  }
  if (candidates.length === 1) {
    return {
      branch: candidates[0].slice(remote.length + 1),
      ref: candidates[0],
      candidates,
      ambiguous: false,
    };
  }
  return { candidates, ambiguous: candidates.length > 1 };
}

async function hasDiff(
  runner: PreflightCommandRunner,
  root: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await runGit(runner, root, args, { allowedExitCodes: [0, 1], signal });
  return result.code === 1;
}

async function gitPathExists(
  runner: PreflightCommandRunner,
  root: string,
  name: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const gitPath = await optionalGitOutput(runner, root, ["rev-parse", "--git-path", name], signal);
  if (!gitPath) return false;
  try {
    await access(path.isAbsolute(gitPath) ? gitPath : path.resolve(root, gitPath));
    return true;
  } catch {
    return false;
  }
}

async function detectOperation(
  runner: PreflightCommandRunner,
  root: string,
  signal?: AbortSignal,
): Promise<GitPreflightState["operation"]> {
  if (await optionalGitOutput(runner, root, ["rev-parse", "--verify", "-q", "MERGE_HEAD"], signal)) {
    return "merge";
  }
  if (
    await gitPathExists(runner, root, "rebase-merge", signal) ||
    await gitPathExists(runner, root, "rebase-apply", signal)
  ) return "rebase";
  if (await optionalGitOutput(runner, root, ["rev-parse", "--verify", "-q", "CHERRY_PICK_HEAD"], signal)) {
    return "cherry-pick";
  }
  if (await optionalGitOutput(runner, root, ["rev-parse", "--verify", "-q", "REVERT_HEAD"], signal)) {
    return "revert";
  }
  if (await gitPathExists(runner, root, "BISECT_LOG", signal)) return "bisect";
  return undefined;
}

export async function inspectGitPreflight(
  cwd: string,
  options: {
    runner?: PreflightCommandRunner;
    signal?: AbortSignal;
    preferredRemote?: string;
  } = {},
): Promise<GitPreflightState> {
  let runner = options.runner ?? spawnPreflightCommand;
  const rootResult = await runGit(runner, cwd, ["rev-parse", "--show-toplevel"], {
    signal: options.signal,
  });
  const root = rootResult.stdout.trim();
  if (!root) throw new ReviewInputError(`Not inside a Git repository: ${cwd}`);
  runner = withCommandEnvironment(
    runner,
    await neutralizedGitConfigEnv(root, options.signal),
  );
  const headSha = (await runGit(runner, root, ["rev-parse", "--verify", "HEAD^{commit}"], {
    signal: options.signal,
  })).stdout.trim();
  const branch = await optionalGitOutput(
    runner,
    root,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    options.signal,
  );
  const remotes = lines((await runGit(runner, root, ["remote"], { signal: options.signal })).stdout)
    .sort((left, right) => left.localeCompare(right, "en"));
  const upstreamRef = branch
    ? await optionalGitOutput(
        runner,
        root,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        options.signal,
        [0, 1, 128],
      )
    : undefined;
  const configuredUpstreamRemote = upstreamRemote(upstreamRef, remotes);
  const preferred = options.preferredRemote !== undefined
    ? { remote: options.preferredRemote, ambiguous: false }
    : choosePreferredRemote(remotes, configuredUpstreamRemote);
  const defaultBranch = await resolveDefaultBranch(runner, root, preferred.remote, options.signal);

  const [
    staged,
    unstaged,
    untrackedOutput,
    unmergedOutput,
    statusOutput,
    operation,
    shallowOutput,
    defaultBranchSha,
  ] = await Promise.all([
    hasDiff(
      runner,
      root,
      ["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--"],
      options.signal,
    ),
    hasDiff(
      runner,
      root,
      ["diff", "--quiet", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--"],
      options.signal,
    ),
    runGit(runner, root, ["ls-files", "--others", "--exclude-standard", "-z"], {
      signal: options.signal,
    }),
    runGit(runner, root, ["ls-files", "--unmerged", "-z"], { signal: options.signal }),
    runGit(
      runner,
      root,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
      { signal: options.signal },
    ),
    detectOperation(runner, root, options.signal),
    runGit(runner, root, ["rev-parse", "--is-shallow-repository"], { signal: options.signal }),
    defaultBranch.ref
      ? optionalGitOutput(
          runner,
          root,
          ["rev-parse", "--verify", `${defaultBranch.ref}^{commit}`],
          options.signal,
          [0, 1, 128],
        )
      : Promise.resolve(undefined),
  ]);

  let ahead: number | undefined;
  let behind: number | undefined;
  let relationAvailable = false;
  if (defaultBranch.ref) {
    const relation = await runGit(
      runner,
      root,
      ["rev-list", "--left-right", "--count", `${defaultBranch.ref}...HEAD`],
      { allowedExitCodes: [0, 1, 128], signal: options.signal },
    );
    if (relation.code === 0) {
      const values = relation.stdout.trim().split(/\s+/u).map(Number);
      if (values.length === 2 && values.every(Number.isInteger)) {
        [behind, ahead] = values;
        relationAvailable = true;
      }
    }
  }

  return {
    root,
    headSha,
    statusSha256: sha256(statusOutput.stdout),
    ...(branch ? { branch } : {}),
    remotes,
    ...(upstreamRef ? { upstreamRef } : {}),
    ...(configuredUpstreamRemote ? { upstreamRemote: configuredUpstreamRemote } : {}),
    ...(preferred.remote ? { preferredRemote: preferred.remote } : {}),
    remoteAmbiguous: preferred.ambiguous,
    ...(defaultBranch.branch ? { defaultBranch: defaultBranch.branch } : {}),
    ...(defaultBranch.ref ? { defaultBranchRef: defaultBranch.ref } : {}),
    ...(defaultBranchSha ? { defaultBranchSha } : {}),
    defaultBranchCandidates: defaultBranch.candidates,
    defaultBranchAmbiguous: defaultBranch.ambiguous,
    ...(ahead !== undefined ? { ahead } : {}),
    ...(behind !== undefined ? { behind } : {}),
    relationAvailable,
    workingTree: {
      staged,
      unstaged,
      untracked: untrackedOutput.stdout.length > 0,
      unmerged: unmergedOutput.stdout.length > 0,
    },
    ...(operation ? { operation } : {}),
    shallow: shallowOutput.stdout.trim() === "true",
  };
}

export interface InteractiveRangeStart {
  /** Full SHA of the earliest commit included in the review. */
  commitSha: string;
  /** Full first-parent SHA immediately before commitSha; becomes range A. */
  parentSha: string;
  subject: string;
  /** Number of commits included through the captured HEAD. */
  commitCount: number;
}

const MAX_INTERACTIVE_RANGE_COMMITS = 128;

function decodeInteractiveRangeStarts(
  output: string,
  expectedHeadSha: string,
  limit: number,
): { starts: InteractiveRangeStart[]; truncated: boolean } {
  const records = output.split("\0");
  if (records.at(-1) === "") records.pop();
  if (records.length % 3 !== 0) {
    throw new ReviewInputError("Git interactive range metadata has an unexpected shape.");
  }
  const starts: InteractiveRangeStart[] = [];
  let expectedSha = expectedHeadSha;
  for (let index = 0; index < records.length; index += 3) {
    const sha = records[index] ?? "";
    const parentText = records[index + 1] ?? "";
    const subject = (records[index + 2] ?? "").trimEnd();
    const parents = parentText.split(/\s+/u).filter(Boolean);
    if (
      !/^[0-9a-f]{40,64}$/u.test(sha) ||
      sha !== expectedSha ||
      parents.some((parent) => (
        !/^[0-9a-f]{40,64}$/u.test(parent) || parent.length !== sha.length
      ))
    ) {
      throw new ReviewInputError(
        "Git interactive range metadata does not form the captured first-parent chain.",
      );
    }
    const parentSha = parents[0];
    if (!parentSha) {
      if (index + 3 !== records.length) {
        throw new ReviewInputError("Git interactive range root is not terminal.");
      }
      break;
    }
    starts.push({
      commitSha: sha,
      parentSha,
      subject,
      commitCount: starts.length + 1,
    });
    expectedSha = parentSha;
  }
  return {
    starts: starts.slice(0, limit),
    truncated: starts.length > limit,
  };
}

/**
 * Return up to 128 first-parent start choices ending at the captured HEAD.
 * Root commits have no parent and are omitted because Git A..B requires A.
 */
export async function listInteractiveRangeStarts(
  root: string,
  headSha: string,
  options: {
    runner?: PreflightCommandRunner;
    signal?: AbortSignal;
    limit?: number;
    /** Optional default-branch SHA; choices stop at its merge-base with HEAD. */
    boundarySha?: string;
  } = {},
): Promise<{ starts: InteractiveRangeStart[]; truncated: boolean; mergeBaseSha?: string }> {
  const limit = options.limit ?? MAX_INTERACTIVE_RANGE_COMMITS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INTERACTIVE_RANGE_COMMITS) {
    throw new ReviewInputError(
      `Interactive range history limit must be between 1 and ${MAX_INTERACTIVE_RANGE_COMMITS}.`,
    );
  }
  if (!/^[0-9a-f]{40,64}$/u.test(headSha)) {
    throw new ReviewInputError("Interactive range selection requires a full captured HEAD SHA.");
  }
  if (
    options.boundarySha !== undefined &&
    (!/^[0-9a-f]{40,64}$/u.test(options.boundarySha) || options.boundarySha.length !== headSha.length)
  ) {
    throw new ReviewInputError("Interactive range boundary must be a full commit SHA.");
  }
  let runner = options.runner ?? spawnPreflightCommand;
  runner = withCommandEnvironment(
    runner,
    await neutralizedGitConfigEnv(root, options.signal),
  );
  let mergeBaseSha: string | undefined;
  if (options.boundarySha) {
    const mergeBase = await runGit(
      runner,
      root,
      ["merge-base", headSha, options.boundarySha],
      { allowedExitCodes: [0, 1], signal: options.signal },
    );
    if (mergeBase.code === 0) {
      mergeBaseSha = mergeBase.stdout.trim();
      if (!/^[0-9a-f]{40,64}$/u.test(mergeBaseSha) || mergeBaseSha.length !== headSha.length) {
        throw new ReviewInputError(
          "Current branch and default branch have no unambiguous merge base for interactive range selection.",
        );
      }
    }
  }
  const revision = mergeBaseSha ? `${mergeBaseSha}..${headSha}` : headSha;
  const result = await runGit(
    runner,
    root,
    [
      "log",
      "--first-parent",
      `--max-count=${limit + 1}`,
      "-z",
      "--format=%H%x00%P%x00%<(160,trunc)%s",
      revision,
    ],
    { signal: options.signal },
  );
  return {
    ...decodeInteractiveRangeStarts(result.stdout, headSha, limit),
    ...(mergeBaseSha ? { mergeBaseSha } : {}),
  };
}

export interface FetchRemoteResult {
  status: "succeeded" | "failed";
  remote: string;
  timedOut: boolean;
}

export async function fetchReviewRemote(
  root: string,
  remote: string,
  options: {
    runner?: PreflightCommandRunner;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<FetchRemoteResult> {
  const runner = options.runner ?? spawnPreflightCommand;
  if (options.signal?.aborted) throw abortedError(options.signal);
  const fetchPath = await safeFetchPath(root);
  if (options.signal?.aborted) throw abortedError(options.signal);
  const urlResult = await runner(
    "git",
    ["-c", "core.fsmonitor=false", "remote", "get-url", "--", remote],
    {
      cwd: root,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
      env: {
        PATH: fetchPath,
        GIT_CONFIG_COUNT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_OPTIONAL_LOCKS: "0",
      },
      unsetEnv: [...inheritedGitEnvironmentKeys(), "GIT_EXTERNAL_DIFF"],
    },
  );
  if (urlResult.aborted) throw abortedError(options.signal);
  if (urlResult.code !== 0 || urlResult.killed) {
    return { status: "failed", remote, timedOut: urlResult.timedOut };
  }
  const remoteUrl = urlResult.stdout.trim();
  if (!remoteUrl) return { status: "failed", remote, timedOut: false };
  const result = await runner(
    "git",
    [
      "-c", "credential.interactive=never",
      "-c", "credential.helper=",
      "-c", "core.askPass=",
      "-c", "core.gitProxy=none",
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "-c", "core.untrackedCache=false",
      "-c", "core.sshCommand=ssh -F /dev/null -o BatchMode=yes -o ProxyCommand=none -o PermitLocalCommand=no -o ClearAllForwardings=yes",
      "-c", "fetch.recurseSubmodules=false",
      "-c", "submodule.recurse=false",
      "-c", "maintenance.auto=false",
      "-c", "gc.auto=0",
      "-c", "uploadpack.packObjectsHook=git pack-objects",
      "-c", "protocol.allow=never",
      "-c", "protocol.http.allow=always",
      "-c", "protocol.https.allow=always",
      "-c", "protocol.ssh.allow=always",
      "-c", "protocol.git.allow=always",
      "-c", "protocol.file.allow=always",
      "-c", "protocol.ext.allow=never",
      "fetch",
      "--no-tags",
      "--quiet",
      "--no-recurse-submodules",
      "--no-auto-maintenance",
      "--upload-pack=git-upload-pack",
      "--",
      remoteUrl,
      `+refs/heads/*:refs/remotes/${remote}/*`,
    ],
    {
      cwd: root,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
      env: {
        PATH: fetchPath,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        SSH_ASKPASS_REQUIRE: "never",
      },
      unsetEnv: [
        "GIT_ALLOW_PROTOCOL",
        "GIT_CONFIG_PARAMETERS",
        "GIT_EXEC_PATH",
        "GIT_EXTERNAL_DIFF",
        "GIT_ASKPASS",
        "GIT_PROXY_COMMAND",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "GIT_SSH_VARIANT",
        "SSH_ASKPASS",
        "SSH_ASKPASS_REQUIRE",
        ...inheritedGitEnvironmentKeys(),
      ],
    },
  );
  if (result.aborted) throw abortedError(options.signal);
  return {
    status: result.code === 0 && !result.killed ? "succeeded" : "failed",
    remote,
    timedOut: result.timedOut,
  };
}

export interface ResolvedPreflightRef {
  ref: string;
  sha: string;
}

export function remotesReferencedByTarget(
  target: ReviewTargetRequest,
  remotes: readonly string[],
): string[] {
  const refs = target.mode === "base"
    ? [target.baseRef]
    : target.mode === "range" ? [target.fromRef, target.toRef] : [];
  return [...new Set(refs.flatMap((ref) => {
    const remote = [...remotes]
      .sort((left, right) => right.length - left.length)
      .find((candidate) => (
        ref.startsWith(`${candidate}/`) ||
        ref.startsWith(`refs/remotes/${candidate}/`) ||
        ref.startsWith(`remotes/${candidate}/`)
      ));
    return remote ? [remote] : [];
  }))].sort((left, right) => left.localeCompare(right, "en"));
}

export function hasLocalChanges(state: GitPreflightState): boolean {
  const working = state.workingTree;
  return working.staged || working.unstaged || working.untracked || working.unmerged;
}
