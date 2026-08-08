import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, open, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { ReviewTargetRequest } from "../types.ts";
import { OversizedReviewInputError, ReviewInputError } from "./errors.ts";
import { assertFrozenInputWithinLimits } from "./limits.ts";

const DEFAULT_MAX_PROCESS_OUTPUT = 32 * 1024 * 1024;
const DIFF_FLAGS = ["--binary", "--no-ext-diff", "--no-textconv", "--full-index", "--find-renames"];
const SUBMODULE_LIMIT = "Git submodule object content is not embedded in the frozen review context.";
const BINARY_LIMIT = "Binary file content is not directly inspectable from the frozen patch.";
const LFS_LIMIT = "Git LFS object content is not materialized; only the committed pointer is available.";

interface RunOptions {
  allowedExitCodes?: number[];
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  maxOutputLines?: number;
  unsetEnv?: readonly string[];
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
    const env = options.env ? { ...process.env, ...options.env } : { ...process.env };
    for (const key of options.unsetEnv ?? []) delete env[key];
    const child = spawn(command, args, {
      cwd,
      env,
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

async function neutralizedGitConfig(root: string): Promise<NodeJS.ProcessEnv> {
  const output = await run(
    "git",
    [
      "config",
      "--null",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process|required)$",
    ],
    root,
    {
      allowedExitCodes: [0, 1],
      env: { GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  const drivers = new Set<string>();
  for (const record of splitNulRecords(output)) {
    let key: string;
    try {
      key = new TextDecoder("utf-8", { fatal: true }).decode(record);
    } catch {
      throw new ReviewInputError("Git filter configuration keys must be valid UTF-8.");
    }
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/iu.exec(key);
    if (match?.[1]) drivers.add(match[1]);
  }

  const entries: Array<[string, string]> = [["core.fsmonitor", "false"]];
  for (const driver of [...drivers].sort((left, right) => left.localeCompare(right, "en"))) {
    entries.push(
      [`filter.${driver}.clean`, ""],
      [`filter.${driver}.smudge`, ""],
      [`filter.${driver}.process`, ""],
      [`filter.${driver}.required`, "false"],
    );
  }
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

async function git(root: string, args: string[], options: RunOptions = {}): Promise<Buffer> {
  const safeConfigEnv = await neutralizedGitConfig(root);
  return run("git", args, root, {
    ...options,
    env: {
      ...options.env,
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      ...safeConfigEnv,
    },
    unsetEnv: [...(options.unsetEnv ?? []), "GIT_CONFIG_PARAMETERS"],
  });
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function splitNulRecords(buffer: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  while (start < buffer.length) {
    const end = buffer.indexOf(0, start);
    if (end < 0) {
      records.push(buffer.subarray(start));
      break;
    }
    if (end > start) records.push(buffer.subarray(start, end));
    start = end + 1;
  }
  return records;
}

function decodeGitPath(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).split(path.sep).join("/");
  } catch {
    throw new ReviewInputError(
      "Git paths must be valid UTF-8 for deterministic adversarial review.",
    );
  }
}

function decodeNulList(buffer: Buffer): string[] {
  return splitNulRecords(buffer).map(decodeGitPath);
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
    ? [SUBMODULE_LIMIT]
    : [];
}

function patchLimitedContext(sections: readonly FrozenPatchSection[]): string[] {
  const patch = sections.map((section) => section.patch).join("\n");
  const limited: string[] = [];
  if (/^(?:GIT binary patch|Binary files .* differ)$/mu.test(patch)) {
    limited.push(BINARY_LIMIT);
  }
  if (patch.includes("version https://git-lfs.github.com/spec/v1")) {
    limited.push(LFS_LIMIT);
  }
  if (patch.includes("Subproject commit")) {
    limited.push(SUBMODULE_LIMIT);
  }
  return limited;
}

const CLASSIFY_PREFIX_BYTES = 8 * 1024;

function classifyContentPrefix(content: Buffer): string[] {
  const limited: string[] = [];
  if (content.includes(0)) limited.push(BINARY_LIMIT);
  if (content.toString("utf8").includes("version https://git-lfs.github.com/spec/v1")) {
    limited.push(LFS_LIMIT);
  }
  return limited;
}

async function readGitBlobPrefix(root: string, objectId: string): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", ["cat-file", "blob", objectId], {
      cwd: root,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (captured >= CLASSIFY_PREFIX_BYTES) return;
      const take = chunk.subarray(0, CLASSIFY_PREFIX_BYTES - captured);
      chunks.push(take);
      captured += take.length;
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new ReviewInputError(`Failed to inspect Git blob ${objectId}: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new ReviewInputError(
        Buffer.concat(stderr).toString("utf8").trim() || `git cat-file exited ${code}.`,
      ));
    });
  });
}

async function rangeObjectLimitedContext(
  root: string,
  toSha: string,
  changedFiles: readonly string[],
): Promise<string[]> {
  const entries = await listRawTree(root, toSha);
  const byFile = new Map(entries.map((entry) => [entry.file, entry]));
  const limited = entries.some((entry) => entry.type === "commit" || entry.mode === "160000")
    ? [SUBMODULE_LIMIT]
    : [];
  for (const file of changedFiles) {
    const entry = byFile.get(file);
    if (!entry || entry.type !== "blob" || entry.mode === "120000") continue;
    limited.push(...classifyContentPrefix(await readGitBlobPrefix(root, entry.objectId)));
  }
  return limited;
}

async function workingObjectLimitedContext(
  root: string,
  changedFiles: readonly string[],
): Promise<string[]> {
  const limited: string[] = [];
  for (const file of changedFiles) {
    const target = path.resolve(root, file);
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new ReviewInputError(`Changed Git path escapes the repository: ${JSON.stringify(file)}.`);
    }
    let info;
    try {
      info = await lstat(target);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      limited.push(SUBMODULE_LIMIT);
      continue;
    }
    if (!info.isFile()) continue;
    const handle = await open(target, "r");
    try {
      const content = Buffer.alloc(Math.min(CLASSIFY_PREFIX_BYTES, info.size));
      const { bytesRead } = await handle.read(content, 0, content.length, 0);
      limited.push(...classifyContentPrefix(content.subarray(0, bytesRead)));
    } finally {
      await handle.close();
    }
  }
  return limited;
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
  const objectLimitedContext = target.mode === "range"
    ? await rangeObjectLimitedContext(root, target.toSha, changedFiles)
    : await workingObjectLimitedContext(root, changedFiles);
  limitedContext = uniqueSorted([
    ...limitedContext,
    ...patchLimitedContext(sections),
    ...objectLimitedContext,
  ]);
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

interface RawTreeEntry {
  mode: string;
  type: "blob" | "commit";
  objectId: string;
  file: string;
}

function parseRawTree(buffer: Buffer): RawTreeEntry[] {
  return splitNulRecords(buffer).map((record) => {
    const tab = record.indexOf(0x09);
    const metadata = tab < 0 ? [] : record.subarray(0, tab).toString("ascii").split(" ");
    const file = tab < 0 ? "" : decodeGitPath(record.subarray(tab + 1));
    if (
      metadata.length !== 3 ||
      (metadata[1] !== "blob" && metadata[1] !== "commit") ||
      !/^[0-9a-f]{40,64}$/u.test(metadata[2]) ||
      !file
    ) {
      throw new ReviewInputError("Git range tree contains a malformed entry.");
    }
    return {
      mode: metadata[0],
      type: metadata[1],
      objectId: metadata[2],
      file,
    };
  });
}

async function listRawTree(root: string, toSha: string): Promise<RawTreeEntry[]> {
  return parseRawTree(await git(
    root,
    ["ls-tree", "-rz", "--full-tree", "-r", toSha],
  ));
}

function safeSnapshotPath(destination: string, file: string): string {
  const target = path.resolve(destination, file);
  const relative = path.relative(destination, target);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new ReviewInputError(`Git range tree path escapes the snapshot: ${JSON.stringify(file)}.`);
  }
  return target;
}

async function writeRawBlob(
  root: string,
  objectId: string,
  target: string,
  mode: number,
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const child = spawn("git", ["cat-file", "blob", objectId], {
    cwd: root,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const output = createWriteStream(target, { flags: "wx", mode });
  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `git cat-file exited ${code}.`));
    });
  });
  try {
    await Promise.all([pipeline(child.stdout, output), exited]);
  } catch (error) {
    child.kill("SIGKILL");
    await rm(target, { force: true });
    throw new ReviewInputError(
      `Failed to extract Git blob ${objectId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Extract committed blobs directly, bypassing export-ignore and all smudge filters. */
export async function extractRangeSnapshot(root: string, toSha: string, destination: string): Promise<void> {
  const entries = await listRawTree(root, toSha);
  for (const entry of entries) {
    const target = safeSnapshotPath(destination, entry.file);
    if (entry.type === "commit" || entry.mode === "160000") {
      await mkdir(target, { recursive: true, mode: 0o700 });
      continue;
    }
    if (entry.mode === "120000") {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const linkTarget = await git(root, ["cat-file", "blob", entry.objectId], {
        maxOutputBytes: 1024 * 1024,
      });
      if (linkTarget.includes(0)) {
        throw new ReviewInputError(
          `Git symlink target contains NUL bytes: ${JSON.stringify(entry.file)}.`,
        );
      }
      await symlink(linkTarget, target);
      continue;
    }
    await writeRawBlob(root, entry.objectId, target, entry.mode === "100755" ? 0o700 : 0o600);
  }
}
