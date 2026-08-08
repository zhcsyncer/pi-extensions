import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { ReviewTargetRequest } from "../types.ts";
import { OversizedReviewInputError, ReviewInputError } from "./errors.ts";
import { assertFrozenInputWithinLimits } from "./limits.ts";

const DEFAULT_MAX_PROCESS_OUTPUT = 32 * 1024 * 1024;
const DIFF_FLAGS = ["--binary", "--no-ext-diff", "--full-index", "--find-renames"];

interface RunOptions {
  allowedExitCodes?: number[];
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  maxOutputLines?: number;
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  options: RunOptions = {},
): Promise<Buffer> {
  const allowed = new Set(options.allowedExitCodes ?? [0]);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_PROCESS_OUTPUT;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputSize = 0;
    let settled = false;

    const collect = (target: Buffer[], chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > maxOutputBytes && !settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new OversizedReviewInputError(
          outputSize,
          0,
          maxOutputBytes,
          options.maxOutputLines ?? Number.MAX_SAFE_INTEGER,
        ));
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new ReviewInputError(`Failed to run ${command}: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== null && allowed.has(code)) {
        resolve(Buffer.concat(stdout));
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(new ReviewInputError(detail || `${command} exited with code ${code ?? "unknown"}.`));
    });
  });
}

async function git(root: string, args: string[], options?: RunOptions): Promise<Buffer> {
  return run("git", args, root, options);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeNulList(buffer: Buffer): string[] {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((value) => value.split(path.sep).join("/"));
}

async function resolveCommit(root: string, ref: string): Promise<string> {
  try {
    return (await git(root, ["rev-parse", "--verify", `${ref}^{commit}`])).toString("utf8").trim();
  } catch {
    throw new ReviewInputError(`Git ref "${ref}" does not resolve to a commit.`);
  }
}

export async function resolveGitRoot(cwd: string): Promise<string> {
  try {
    return (await run("git", ["rev-parse", "--show-toplevel"], cwd)).toString("utf8").trim();
  } catch {
    throw new ReviewInputError(`Not inside a Git repository: ${cwd}`);
  }
}

export type ResolvedReviewTarget =
  | { mode: "local" }
  | { mode: "base"; baseSha: string; baseRef: string }
  | { mode: "range"; fromSha: string; toSha: string; fromRef: string; toRef: string };

export async function resolveReviewTarget(
  root: string,
  request: ReviewTargetRequest,
): Promise<ResolvedReviewTarget> {
  if (request.mode === "local") return request;
  if (request.mode === "base") {
    return {
      mode: "base",
      baseRef: request.baseRef,
      baseSha: await resolveCommit(root, request.baseRef),
    };
  }
  return {
    mode: "range",
    fromRef: request.fromRef,
    toRef: request.toRef,
    fromSha: await resolveCommit(root, request.fromRef),
    toSha: await resolveCommit(root, request.toRef),
  };
}

export interface FrozenPatchSection {
  title: string;
  patch: string;
}

export interface CaptureLimits {
  maxBytes: number;
  maxLines: number;
}

export interface TargetCapture {
  headSha: string;
  statusSha256: string;
  targetSha256: string;
  changedFiles: string[];
  sections: FrozenPatchSection[];
  limitedContext: string[];
  description: string;
}

async function untrackedFiles(root: string, limits: CaptureLimits): Promise<string[]> {
  return decodeNulList(await git(
    root,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { maxOutputBytes: limits.maxBytes, maxOutputLines: limits.maxLines },
  ));
}

async function syntheticUntrackedPatches(
  root: string,
  files: string[],
  limits: CaptureLimits,
): Promise<string> {
  const patches: string[] = [];
  for (const file of files) {
    const output = await git(
      root,
      ["diff", "--no-index", ...DIFF_FLAGS, "--", "/dev/null", file],
      {
        allowedExitCodes: [0, 1],
        maxOutputBytes: limits.maxBytes,
        maxOutputLines: limits.maxLines,
      },
    );
    if (output.length > 0) {
      patches.push(output.toString("utf8"));
      assertFrozenInputWithinLimits(patches.join("\n"), limits.maxBytes, limits.maxLines);
    }
  }
  return patches.join("\n");
}

async function currentHead(root: string): Promise<string> {
  return resolveCommit(root, "HEAD");
}

async function statusFingerprint(root: string, limits: CaptureLimits): Promise<string> {
  return sha256(await git(
    root,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
    { maxOutputBytes: limits.maxBytes, maxOutputLines: limits.maxLines },
  ));
}

async function diff(root: string, args: string[], limits: CaptureLimits): Promise<string> {
  return (await git(
    root,
    ["diff", ...DIFF_FLAGS, "--ignore-submodules=none", ...args, "--"],
    { maxOutputBytes: limits.maxBytes, maxOutputLines: limits.maxLines },
  )).toString("utf8");
}

async function diffNames(root: string, args: string[], limits: CaptureLimits): Promise<string[]> {
  return decodeNulList(await git(
    root,
    ["diff", "--name-only", "-z", "--ignore-submodules=none", ...args, "--"],
    { maxOutputBytes: limits.maxBytes, maxOutputLines: limits.maxLines },
  ));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

async function rangeLimitedContext(
  root: string,
  fromSha: string,
  toSha: string,
  limits: CaptureLimits,
): Promise<string[]> {
  const raw = (await git(
    root,
    ["diff", "--raw", "--ignore-submodules=none", `${fromSha}...${toSha}`, "--"],
    { maxOutputBytes: limits.maxBytes, maxOutputLines: limits.maxLines },
  )).toString("utf8");
  return raw.split("\n").some((line) => /^:160000\s|\s160000\s/u.test(line))
    ? ["Git submodule content is not included in the range snapshot."]
    : [];
}

export async function captureReviewTarget(
  root: string,
  target: ResolvedReviewTarget,
  limits: CaptureLimits,
): Promise<TargetCapture> {
  const headSha = await currentHead(root);
  const untracked = target.mode === "range" ? [] : await untrackedFiles(root, limits);
  const untrackedPatch = target.mode === "range"
    ? ""
    : await syntheticUntrackedPatches(root, untracked, limits);
  let sections: FrozenPatchSection[];
  let trackedNames: string[];
  let description: string;
  let limitedContext: string[] = [];

  if (target.mode === "range") {
    const rangeSpec = `${target.fromSha}...${target.toSha}`;
    sections = [{ title: "Committed range patch", patch: await diff(root, [rangeSpec], limits) }];
    trackedNames = await diffNames(root, [rangeSpec], limits);
    description = `range ${target.fromRef} (${target.fromSha}) .. ${target.toRef} (${target.toSha})`;
    limitedContext = await rangeLimitedContext(root, target.fromSha, target.toSha, limits);
  } else {
    const staged = await diff(root, ["--cached"], limits);
    const unstaged = await diff(root, [], limits);
    sections = [];
    trackedNames = [
      ...(await diffNames(root, ["--cached"], limits)),
      ...(await diffNames(root, [], limits)),
    ];
    if (target.mode === "base") {
      const committedSpec = `${target.baseSha}...${headSha}`;
      sections.push({ title: "Committed base patch", patch: await diff(root, [committedSpec], limits) });
      trackedNames.push(...await diffNames(root, [committedSpec], limits));
      description = `base ${target.baseRef} (${target.baseSha}) ... HEAD (${headSha}) plus local changes`;
    } else {
      description = `local changes at HEAD ${headSha}`;
    }
    sections.push(
      { title: "Staged patch", patch: staged },
      { title: "Unstaged patch", patch: unstaged },
      { title: "Untracked synthetic-add patch", patch: untrackedPatch },
    );
  }

  const changedFiles = uniqueSorted([...trackedNames, ...untracked]);
  assertFrozenInputWithinLimits(
    sections.map(({ patch }) => patch).join("\n"),
    limits.maxBytes,
    limits.maxLines,
  );
  const targetMaterial = JSON.stringify({
    mode: target.mode,
    target,
    changedFiles,
    sections: sections.map(({ title, patch }) => ({ title, patch })),
  });

  return {
    headSha,
    statusSha256: await statusFingerprint(root, limits),
    targetSha256: sha256(targetMaterial),
    changedFiles,
    sections,
    limitedContext,
    description,
  };
}

export async function extractRangeSnapshot(root: string, toSha: string, destination: string): Promise<void> {
  const indexPath = path.join(path.dirname(destination), "range.index");
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    await run("git", ["read-tree", toSha], root, { env });
    const prefix = destination.endsWith(path.sep) ? destination : `${destination}${path.sep}`;
    await run("git", ["checkout-index", "--all", "--force", `--prefix=${prefix}`], root, { env });
  } finally {
    await rm(indexPath, { force: true });
  }
}
