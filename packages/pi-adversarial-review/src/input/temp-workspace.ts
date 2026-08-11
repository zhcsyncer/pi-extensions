import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  statfs,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ReviewInputError } from "./errors.ts";
import {
  INHERITED_GIT_CONTEXT_ENV_KEYS,
  neutralizedGitConfigEnv,
  type RangeCheckoutEstimate,
} from "./git-target.ts";

export const REVIEW_TEMP_TTL_MS = 24 * 60 * 60_000;
export const MAX_RANGE_CHECKOUT_ENTRIES = 100_000;
export const MAX_RANGE_CHECKOUT_LOGICAL_BYTES = 2n * 1024n * 1024n * 1024n;
export const MIN_RANGE_CHECKOUT_FREE_BYTES = 512n * 1024n * 1024n;
const RANGE_CHECKOUT_FREE_MULTIPLIER = 2n;
const COMMON_GIT_ADMIN_BASE_RESERVE_BYTES = 16n * 1024n * 1024n;
const COMMON_GIT_ADMIN_BYTES_PER_ENTRY = 256n;
const CHECKOUT_FREE_SPACE_POLL_MS = 50;
const OWNER_VERSION = 2;
const OWNER_MANIFEST = "worktree-owner.json";
const ADMIN_MARKER = "pi-adversarial-review-owner.json";
const SCAVENGE_OWNER_VERSION = 1;
const SCAVENGE_OWNER_MANIFEST = "scavenge-owner.json";
const LOCK_REASON_PREFIX = "pi-adversarial-review:";

export interface RangeCheckoutPolicy {
  maxEntries: number;
  maxLogicalBytes: bigint;
  minFreeBytes: bigint;
  freeSpaceMultiplier: bigint;
}

export interface RangeCheckoutDependencies {
  policy?: Partial<RangeCheckoutPolicy>;
  statfs?: typeof statfs;
  filesystemIdentity?: (target: string) => Promise<string>;
  checkoutPollMs?: number;
}

interface WorkspaceOwnership {
  version: typeof OWNER_VERSION;
  state: "workspace";
  ownerPid: number;
  runDir: string;
}

interface CompletedOwnership extends Omit<WorkspaceOwnership, "state"> {
  state: "completed";
}

interface PendingWorktreeOwnership extends Omit<WorkspaceOwnership, "state"> {
  state: "pending";
  token: string;
  worktreePath: string;
  commonGitDir: string;
  targetSha: string;
}

interface OwnedWorktreeOwnership extends Omit<PendingWorktreeOwnership, "state"> {
  state: "owned";
  adminDir: string;
  adminDev: string;
  adminIno: string;
}

interface RemovingWorktreeOwnership extends Omit<OwnedWorktreeOwnership, "state"> {
  state: "registration-removing";
  quarantineDir: string;
  markerPresent: boolean;
  previousState: "pending" | "owned";
}

type WorktreeOwnership =
  | WorkspaceOwnership
  | PendingWorktreeOwnership
  | OwnedWorktreeOwnership
  | RemovingWorktreeOwnership
  | CompletedOwnership;

interface AdminMarker {
  version: typeof OWNER_VERSION;
  token: string;
  worktreePath: string;
}

interface ScavengeOwnership {
  version: typeof SCAVENGE_OWNER_VERSION;
  ownerPid: number;
}

interface ProvenRegistration {
  adminDir: string;
  adminDev: string;
  adminIno: string;
}

export interface ReviewTempWorkspace {
  runDir: string;
  inputPath: string;
  worktreeDir: string;
  writeInput(content: string): Promise<void>;
  createRangeWorktree(options: {
    root: string;
    toSha: string;
    estimate: RangeCheckoutEstimate;
    signal?: AbortSignal;
    dependencies?: RangeCheckoutDependencies;
  }): Promise<string>;
  cleanup(): Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("Adversarial review linked-worktree operation cancelled.");
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The process group may already have exited.
    }
  }
  try { child.kill("SIGKILL"); } catch { /* already exited */ }
}

async function hardenedWorktreeEnv(
  root: string,
  hooksDir: string,
  signal?: AbortSignal,
): Promise<NodeJS.ProcessEnv> {
  const neutralized = await neutralizedGitConfigEnv(root, signal);
  const count = Number(neutralized.GIT_CONFIG_COUNT ?? "0");
  const entries: Array<[string, string]> = [
    ["core.hooksPath", hooksDir],
    ["core.fsmonitor", "false"],
    ["core.untrackedCache", "false"],
    ["core.symlinks", "false"],
    ["core.autocrlf", "false"],
    ["core.eol", "lf"],
    ["submodule.recurse", "false"],
    ["fetch.recurseSubmodules", "false"],
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...neutralized,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_ATTR_NOSYSTEM: "1",
  };
  for (const key of INHERITED_GIT_CONTEXT_ENV_KEYS) delete env[key];
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key) && !(key in neutralized)) delete env[key];
  }
  entries.forEach(([key, value], offset) => {
    env[`GIT_CONFIG_KEY_${count + offset}`] = key;
    env[`GIT_CONFIG_VALUE_${count + offset}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(count + entries.length);
  return env;
}

async function runGit(options: {
  root: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  operation: string;
  monitor?: () => Promise<void>;
  monitorIntervalMs?: number;
}): Promise<string> {
  if (options.signal?.aborted) throw abortError(options.signal);
  return await new Promise((resolve, reject) => {
    const child = spawn("git", options.args, {
      cwd: options.root,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let aborted = false;
    let monitorError: unknown;
    let monitorTimer: NodeJS.Timeout | undefined;
    let monitorInFlight: Promise<void> | undefined;
    let childClosed = false;
    const finish = () => {
      options.signal?.removeEventListener("abort", onAbort);
      if (monitorTimer) clearInterval(monitorTimer);
    };
    const onAbort = () => {
      if (settled) return;
      aborted = true;
      killProcessTree(child);
    };
    const poll = (): Promise<void> => {
      if (settled || childClosed || !options.monitor) return Promise.resolve();
      if (monitorInFlight) return monitorInFlight;
      monitorInFlight = (async () => {
        try {
          await options.monitor!();
        } catch (error) {
          if (!monitorError) {
            monitorError = error;
            killProcessTree(child);
          }
        } finally {
          monitorInFlight = undefined;
        }
      })();
      return monitorInFlight;
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    if (options.monitor) {
      void poll();
      monitorTimer = setInterval(() => { void poll(); }, options.monitorIntervalMs ?? CHECKOUT_FREE_SPACE_POLL_MS);
      monitorTimer.unref();
    }
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      finish();
      reject(aborted
        ? abortError(options.signal)
        : monitorError ?? new ReviewInputError(`${options.operation} failed: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled || childClosed) return;
      childClosed = true;
      finish();
      void (async () => {
        await monitorInFlight;
        if (!aborted && !monitorError && code === 0 && options.monitor) {
          try {
            await options.monitor();
          } catch (error) {
            monitorError = error;
          }
        }
        if (settled) return;
        settled = true;
        if (aborted) {
          reject(abortError(options.signal));
        } else if (monitorError) {
          reject(monitorError);
        } else if (code === 0) {
          resolve(Buffer.concat(stdout).toString("utf8").trim());
        } else {
          const detail = Buffer.concat(stderr).toString("utf8").trim();
          reject(new ReviewInputError(
            `${options.operation} failed${detail ? `: ${detail}` : ` with exit code ${code ?? "unknown"}`}.`,
          ));
        }
      })().catch(reject);
    });
  });
}

function resolvedPolicy(overrides?: Partial<RangeCheckoutPolicy>): RangeCheckoutPolicy {
  const policy = {
    maxEntries: MAX_RANGE_CHECKOUT_ENTRIES,
    maxLogicalBytes: MAX_RANGE_CHECKOUT_LOGICAL_BYTES,
    minFreeBytes: MIN_RANGE_CHECKOUT_FREE_BYTES,
    freeSpaceMultiplier: RANGE_CHECKOUT_FREE_MULTIPLIER,
    ...overrides,
  };
  if (
    !Number.isInteger(policy.maxEntries) || policy.maxEntries < 0 ||
    policy.maxLogicalBytes < 0n || policy.minFreeBytes < 0n || policy.freeSpaceMultiplier < 0n
  ) {
    throw new ReviewInputError("Range checkout capacity policy must use non-negative integer limits.");
  }
  return policy;
}

async function availableFilesystemBytes(
  target: string,
  statfsImpl: typeof statfs,
): Promise<bigint> {
  const fs = await statfsImpl(target, { bigint: true });
  return fs.bavail * fs.bsize;
}

async function defaultFilesystemIdentity(target: string): Promise<string> {
  return String((await lstat(target)).dev);
}

function commonGitReserve(entries: number): bigint {
  return COMMON_GIT_ADMIN_BASE_RESERVE_BYTES + BigInt(entries) * COMMON_GIT_ADMIN_BYTES_PER_ENTRY;
}

export async function assertRangeCheckoutCapacity(options: {
  tempPath: string;
  commonGitPath?: string;
  estimate: RangeCheckoutEstimate;
  dependencies?: RangeCheckoutDependencies;
}): Promise<{ availableBytes: bigint; requiredBytes: bigint }> {
  const policy = resolvedPolicy(options.dependencies?.policy);
  const logicalBytes = BigInt(options.estimate.logicalBytes);
  if (options.estimate.entries > policy.maxEntries) {
    throw new ReviewInputError(
      `Range checkout entry limit exceeded: measured=${options.estimate.entries}, allowed=${policy.maxEntries}.`,
    );
  }
  if (logicalBytes > policy.maxLogicalBytes) {
    throw new ReviewInputError(
      `Range checkout logical-byte limit exceeded: measured=${logicalBytes}, allowed=${policy.maxLogicalBytes}.`,
    );
  }
  const statfsImpl = options.dependencies?.statfs ?? statfs;
  const filesystemIdentity = options.dependencies?.filesystemIdentity ?? defaultFilesystemIdentity;
  const checkoutRequired = policy.minFreeBytes + logicalBytes * policy.freeSpaceMultiplier;
  if (options.commonGitPath) {
    const [tempIdentity, commonIdentity] = await Promise.all([
      filesystemIdentity(options.tempPath),
      filesystemIdentity(options.commonGitPath),
    ]);
    const commonRequired = commonGitReserve(options.estimate.entries);
    if (tempIdentity === commonIdentity) {
      const availableBytes = await availableFilesystemBytes(options.tempPath, statfsImpl);
      const requiredBytes = checkoutRequired + commonRequired;
      if (availableBytes < requiredBytes) {
        throw new ReviewInputError(
          `Shared checkout/common-Git filesystem free-space requirement not met: measured logical=${logicalBytes}, ` +
            `entries=${options.estimate.entries}, available=${availableBytes}, required=${requiredBytes} bytes.`,
        );
      }
      return { availableBytes, requiredBytes };
    }
    const availableBytes = await availableFilesystemBytes(options.tempPath, statfsImpl);
    if (availableBytes < checkoutRequired) {
      throw new ReviewInputError(
        `Range checkout free-space requirement not met: measured logical=${logicalBytes}, ` +
          `allowed logical=${policy.maxLogicalBytes}, available=${availableBytes}, required=${checkoutRequired} bytes.`,
      );
    }
    const commonAvailable = await availableFilesystemBytes(options.commonGitPath, statfsImpl);
    if (commonAvailable < commonRequired) {
      throw new ReviewInputError(
        `Common Git filesystem free-space requirement not met: entries=${options.estimate.entries}, ` +
          `available=${commonAvailable}, required=${commonRequired} bytes.`,
      );
    }
    return { availableBytes, requiredBytes: checkoutRequired };
  }
  const availableBytes = await availableFilesystemBytes(options.tempPath, statfsImpl);
  if (availableBytes < checkoutRequired) {
    throw new ReviewInputError(
      `Range checkout free-space requirement not met: measured logical=${logicalBytes}, ` +
        `allowed logical=${policy.maxLogicalBytes}, available=${availableBytes}, required=${checkoutRequired} bytes.`,
    );
  }
  return { availableBytes, requiredBytes: checkoutRequired };
}

async function readJsonRegular<T>(file: string, numericUid?: number): Promise<T> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (numericUid !== undefined && info.uid !== numericUid)) {
    throw new Error(`Ownership metadata is not a same-UID regular file: ${file}`);
  }
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function readRegular(file: string, numericUid?: number): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (numericUid !== undefined && info.uid !== numericUid)) {
    throw new Error(`Ownership proof is not a same-UID regular file: ${file}`);
  }
  return readFile(file, "utf8");
}

function workspaceLooksValid(
  value: WorkspaceOwnership | CompletedOwnership,
  expectedRunDir: string,
): boolean {
  return value.version === OWNER_VERSION &&
    (value.state === "workspace" || value.state === "completed") &&
    Number.isSafeInteger(value.ownerPid) && value.ownerPid > 0 &&
    value.runDir === expectedRunDir;
}

function pendingLooksValid(value: PendingWorktreeOwnership, expectedRunDir: string): boolean {
  return workspaceLooksValid({ ...value, state: "workspace" }, expectedRunDir) &&
    value.state === "pending" &&
    typeof value.token === "string" && /^[0-9a-f]{64}$/u.test(value.token) &&
    value.worktreePath === path.join(expectedRunDir, "worktree") &&
    path.isAbsolute(value.commonGitDir) && /^[0-9a-f]{40,64}$/u.test(value.targetSha);
}

function ownedBaseLooksValid(
  value: OwnedWorktreeOwnership | RemovingWorktreeOwnership,
  expectedRunDir: string,
): boolean {
  const worktreesRoot = path.join(value.commonGitDir, "worktrees");
  const adminRelative = path.relative(worktreesRoot, value.adminDir);
  return pendingLooksValid({ ...value, state: "pending" }, expectedRunDir) &&
    !!adminRelative && !adminRelative.includes(path.sep) && adminRelative !== ".." &&
    typeof value.adminDev === "string" && typeof value.adminIno === "string";
}

function ownedLooksValid(value: OwnedWorktreeOwnership, expectedRunDir: string): boolean {
  return value.state === "owned" && ownedBaseLooksValid(value, expectedRunDir);
}

function adminQuarantinePath(value: Pick<OwnedWorktreeOwnership, "commonGitDir" | "token">): string {
  return path.join(value.commonGitDir, ".pi-adversarial-review-quarantine", value.token);
}

function removingLooksValid(value: RemovingWorktreeOwnership, expectedRunDir: string): boolean {
  return value.state === "registration-removing" &&
    ownedBaseLooksValid(value, expectedRunDir) &&
    value.quarantineDir === adminQuarantinePath(value) &&
    typeof value.markerPresent === "boolean" &&
    (value.previousState === "pending" || value.previousState === "owned");
}

function manifestLooksValid(value: WorktreeOwnership, expectedRunDir: string): boolean {
  switch (value.state) {
    case "workspace":
      return workspaceLooksValid(value, expectedRunDir) && !("token" in value);
    case "completed":
      return workspaceLooksValid(value, expectedRunDir) && !("token" in value);
    case "pending":
      return pendingLooksValid(value, expectedRunDir);
    case "owned":
      return ownedLooksValid(value, expectedRunDir);
    case "registration-removing":
      return removingLooksValid(value, expectedRunDir);
  }
}

function lockReason(token: string): string {
  return `${LOCK_REASON_PREFIX}${token}`;
}

async function verifyAdminRegistration(
  ownership: PendingWorktreeOwnership,
  adminDir: string,
  numericUid?: number,
): Promise<ProvenRegistration> {
  const worktreesRoot = path.join(ownership.commonGitDir, "worktrees");
  const relativeAdmin = path.relative(worktreesRoot, adminDir);
  if (!relativeAdmin || relativeAdmin.includes(path.sep) || relativeAdmin === "..") {
    throw new Error("Linked-worktree admin path is outside the immediate common Git worktrees directory.");
  }
  const admin = await lstat(adminDir);
  if (
    !admin.isDirectory() || admin.isSymbolicLink() ||
    (numericUid !== undefined && admin.uid !== numericUid)
  ) {
    throw new Error("Linked-worktree admin entry is not a same-UID real directory.");
  }
  const locked = (await readRegular(path.join(adminDir, "locked"), numericUid)).trim();
  if (locked !== lockReason(ownership.token)) {
    throw new Error("Linked-worktree lock reason does not prove extension ownership.");
  }
  const gitdir = (await readRegular(path.join(adminDir, "gitdir"), numericUid)).trim();
  if (path.resolve(gitdir) !== path.resolve(ownership.worktreePath, ".git")) {
    throw new Error("Linked-worktree admin entry points at a different checkout.");
  }
  return { adminDir, adminDev: String(admin.dev), adminIno: String(admin.ino) };
}

async function findPendingRegistration(
  ownership: PendingWorktreeOwnership,
  numericUid?: number,
): Promise<ProvenRegistration | undefined> {
  let entries: string[];
  try {
    entries = await readdir(path.join(ownership.commonGitDir, "worktrees"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  const matches: ProvenRegistration[] = [];
  for (const entry of entries) {
    const adminDir = path.join(ownership.commonGitDir, "worktrees", entry);
    try {
      matches.push(await verifyAdminRegistration(ownership, adminDir, numericUid));
    } catch {
      // Only the exact random lock reason, path, and target are ownership proof.
    }
  }
  if (matches.length > 1) throw new Error("Multiple linked-worktree registrations claim one ownership token.");
  return matches[0];
}

async function verifyOwnedRegistration(
  ownership: OwnedWorktreeOwnership,
  expectedRunDir: string,
  numericUid?: number,
): Promise<ProvenRegistration> {
  if (!ownedLooksValid(ownership, expectedRunDir)) {
    throw new Error("Linked-worktree ownership manifest is malformed or path-mismatched.");
  }
  const admin = await lstat(ownership.adminDir);
  if (
    !admin.isDirectory() || admin.isSymbolicLink() ||
    (numericUid !== undefined && admin.uid !== numericUid) ||
    String(admin.dev) !== ownership.adminDev || String(admin.ino) !== ownership.adminIno
  ) {
    throw new Error("Linked-worktree admin identity no longer matches its ownership manifest.");
  }
  const locked = (await readRegular(path.join(ownership.adminDir, "locked"), numericUid)).trim();
  if (locked !== lockReason(ownership.token)) {
    throw new Error("Linked-worktree lock reason no longer matches its private manifest.");
  }
  const marker = await readJsonRegular<AdminMarker>(path.join(ownership.adminDir, ADMIN_MARKER), numericUid);
  if (
    marker.version !== OWNER_VERSION || marker.token !== ownership.token ||
    marker.worktreePath !== ownership.worktreePath
  ) {
    throw new Error("Linked-worktree admin marker does not match its private manifest.");
  }
  const gitdir = (await readRegular(path.join(ownership.adminDir, "gitdir"), numericUid)).trim();
  if (path.resolve(gitdir) !== path.resolve(ownership.worktreePath, ".git")) {
    throw new Error("Linked-worktree admin entry points at a different checkout.");
  }
  return {
    adminDir: ownership.adminDir,
    adminDev: ownership.adminDev,
    adminIno: ownership.adminIno,
  };
}

async function verifyCheckoutDotGit(
  checkoutPath: string,
  adminDir: string,
  numericUid?: number,
): Promise<void> {
  const dotGit = (await readRegular(path.join(checkoutPath, ".git"), numericUid)).trim();
  if (dotGit !== `gitdir: ${adminDir}`) {
    throw new Error("Linked-worktree checkout identity no longer matches its admin entry.");
  }
}

async function pathMissing(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return false;
  } catch (error: any) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function removePlainTree(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeJsonAtomically(target: string, value: unknown): Promise<void> {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.pi-owner-${randomBytes(12).toString("hex")}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

interface RemovalDependencies {
  removeTree?: (target: string) => Promise<void>;
  rename?: typeof rename;
  writeScavengeMarker?: (target: string, value: unknown) => Promise<void>;
}

async function ensureAdminQuarantineRoot(commonGitDir: string, numericUid?: number): Promise<void> {
  const quarantineRoot = path.join(commonGitDir, ".pi-adversarial-review-quarantine");
  await mkdir(quarantineRoot, { mode: 0o700 }).catch((error: any) => {
    if (error?.code !== "EEXIST") throw error;
  });
  const [common, quarantine] = await Promise.all([lstat(commonGitDir), lstat(quarantineRoot)]);
  if (
    !quarantine.isDirectory() || quarantine.isSymbolicLink() || quarantine.dev !== common.dev ||
    (numericUid !== undefined && quarantine.uid !== numericUid)
  ) {
    throw new Error("Extension admin quarantine is not a same-filesystem, same-UID real directory.");
  }
}

function completedOwnership(ownership: WorktreeOwnership): CompletedOwnership {
  return {
    version: OWNER_VERSION,
    state: "completed",
    ownerPid: ownership.ownerPid,
    runDir: ownership.runDir,
  };
}

function removingOwnership(
  ownership: PendingWorktreeOwnership | OwnedWorktreeOwnership,
  registration: ProvenRegistration,
): RemovingWorktreeOwnership {
  return {
    ...ownership,
    state: "registration-removing",
    ...registration,
    quarantineDir: adminQuarantinePath(ownership),
    markerPresent: ownership.state === "owned",
    previousState: ownership.state,
  };
}

function priorOwnership(ownership: RemovingWorktreeOwnership): PendingWorktreeOwnership | OwnedWorktreeOwnership {
  const {
    adminDir, adminDev, adminIno, quarantineDir, markerPresent, previousState, ...base
  } = ownership;
  if (previousState === "pending") return { ...base, state: "pending" };
  return { ...base, state: "owned", adminDir, adminDev, adminIno };
}

async function verifyQuarantinedRegistration(
  ownership: RemovingWorktreeOwnership,
  checkoutPath: string,
  numericUid?: number,
): Promise<void> {
  if (!(await pathMissing(ownership.adminDir))) {
    throw new Error("A public linked-worktree admin entry appeared during isolation.");
  }
  const admin = await lstat(ownership.quarantineDir);
  if (
    !admin.isDirectory() || admin.isSymbolicLink() ||
    (numericUid !== undefined && admin.uid !== numericUid) ||
    String(admin.dev) !== ownership.adminDev || String(admin.ino) !== ownership.adminIno
  ) {
    throw new Error("Isolated linked-worktree admin identity changed after atomic rename.");
  }
  const locked = (await readRegular(path.join(ownership.quarantineDir, "locked"), numericUid)).trim();
  if (locked !== lockReason(ownership.token)) {
    throw new Error("Isolated linked-worktree lock reason no longer proves extension ownership.");
  }
  const gitdir = (await readRegular(path.join(ownership.quarantineDir, "gitdir"), numericUid)).trim();
  if (path.resolve(gitdir) !== path.resolve(ownership.worktreePath, ".git")) {
    throw new Error("Isolated linked-worktree admin entry points at a different checkout.");
  }
  if (ownership.markerPresent) {
    const marker = await readJsonRegular<AdminMarker>(
      path.join(ownership.quarantineDir, ADMIN_MARKER),
      numericUid,
    );
    if (
      marker.version !== OWNER_VERSION || marker.token !== ownership.token ||
      marker.worktreePath !== ownership.worktreePath
    ) {
      throw new Error("Isolated linked-worktree marker no longer matches its private manifest.");
    }
  }
  if (!(await pathMissing(checkoutPath))) {
    await verifyCheckoutDotGit(checkoutPath, ownership.adminDir, numericUid);
  }
}

async function isolateAndRemoveRegistration(options: {
  ownership: PendingWorktreeOwnership | OwnedWorktreeOwnership | RemovingWorktreeOwnership;
  registration?: ProvenRegistration;
  manifestPath: string;
  expectedRunDir: string;
  checkoutPath: string;
  numericUid?: number;
  dependencies?: RemovalDependencies;
}): Promise<CompletedOwnership> {
  const renameImpl = options.dependencies?.rename ?? rename;
  const removeTree = options.dependencies?.removeTree ?? removePlainTree;
  let removing = options.ownership.state === "registration-removing"
    ? options.ownership
    : removingOwnership(options.ownership, options.registration!);
  if (!removingLooksValid(removing, options.expectedRunDir)) {
    throw new Error("Registration-removal manifest is malformed or path-mismatched.");
  }
  await ensureAdminQuarantineRoot(removing.commonGitDir, options.numericUid);
  const publicMissing = await pathMissing(removing.adminDir);
  const quarantineMissing = await pathMissing(removing.quarantineDir);
  if (options.ownership.state !== "registration-removing" && !quarantineMissing) {
    throw new Error("Token-derived admin quarantine path is already occupied; it was preserved.");
  }
  if (publicMissing && quarantineMissing) {
    if (!(await pathMissing(options.checkoutPath))) {
      await verifyCheckoutDotGit(options.checkoutPath, removing.adminDir, options.numericUid);
    }
    const completed = completedOwnership(removing);
    await writeJsonAtomically(options.manifestPath, completed);
    return completed;
  }
  if (!publicMissing && !quarantineMissing) {
    throw new Error("Both public and private linked-worktree admin paths exist; neither was removed.");
  }
  if (!publicMissing) {
    if (options.ownership.state === "registration-removing") {
      if (removing.markerPresent) {
        await verifyOwnedRegistration(
          { ...removing, state: "owned" },
          options.expectedRunDir,
          options.numericUid,
        );
      } else {
        await verifyAdminRegistration(
          { ...removing, state: "pending" },
          removing.adminDir,
          options.numericUid,
        );
      }
    }
    if (!(await pathMissing(removing.quarantineDir))) {
      throw new Error("Token-derived admin quarantine path is already occupied.");
    }
    await writeJsonAtomically(options.manifestPath, removing);
    try {
      await renameImpl(removing.adminDir, removing.quarantineDir);
      await verifyQuarantinedRegistration(removing, options.checkoutPath, options.numericUid);
      if (!removing.markerPresent) {
        await writeJsonAtomically(path.join(removing.quarantineDir, ADMIN_MARKER), {
          version: OWNER_VERSION,
          token: removing.token,
          worktreePath: removing.worktreePath,
        } satisfies AdminMarker);
        removing = { ...removing, markerPresent: true };
        await writeJsonAtomically(options.manifestPath, removing);
        await verifyQuarantinedRegistration(removing, options.checkoutPath, options.numericUid);
      }
    } catch (error) {
      try {
        if (!(await pathMissing(removing.quarantineDir)) && await pathMissing(removing.adminDir)) {
          await renameImpl(removing.quarantineDir, removing.adminDir);
          await writeJsonAtomically(options.manifestPath, priorOwnership(removing));
        }
      } catch {
        // Keep the durable removal state and both paths intact for a later safe retry.
      }
      throw error;
    }
  } else {
    try {
      await verifyQuarantinedRegistration(removing, options.checkoutPath, options.numericUid);
      if (!removing.markerPresent) {
        await writeJsonAtomically(path.join(removing.quarantineDir, ADMIN_MARKER), {
          version: OWNER_VERSION,
          token: removing.token,
          worktreePath: removing.worktreePath,
        } satisfies AdminMarker);
        removing = { ...removing, markerPresent: true };
        await writeJsonAtomically(options.manifestPath, removing);
        await verifyQuarantinedRegistration(removing, options.checkoutPath, options.numericUid);
      }
    } catch (error) {
      try {
        if (!(await pathMissing(removing.quarantineDir)) && await pathMissing(removing.adminDir)) {
          await renameImpl(removing.quarantineDir, removing.adminDir);
          await writeJsonAtomically(options.manifestPath, priorOwnership(removing));
        }
      } catch {
        // Keep the durable removal state and both paths intact for a later safe retry.
      }
      throw error;
    }
  }
  await removeTree(removing.quarantineDir);
  if (!(await pathMissing(removing.quarantineDir))) {
    throw new Error("Private linked-worktree admin quarantine could not be removed.");
  }
  const completed = completedOwnership(removing);
  await writeJsonAtomically(options.manifestPath, completed);
  return completed;
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function scavengeOwnershipLooksValid(value: unknown): value is ScavengeOwnership {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "ownerPid,version" &&
    record.version === SCAVENGE_OWNER_VERSION &&
    Number.isSafeInteger(record.ownerPid) && Number(record.ownerPid) > 0;
}

type ScavengeOwnerStatus =
  | { kind: "missing" }
  | { kind: "malformed" }
  | { kind: "valid"; ownership: ScavengeOwnership };

async function readScavengeOwnership(
  quarantineDir: string,
  numericUid: number,
): Promise<ScavengeOwnerStatus> {
  const markerPath = path.join(quarantineDir, SCAVENGE_OWNER_MANIFEST);
  let handle;
  try {
    handle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: any) {
    return error?.code === "ENOENT" ? { kind: "missing" } : { kind: "malformed" };
  }
  try {
    const markerInfo = await handle.stat();
    if (
      !markerInfo.isFile() || markerInfo.uid !== numericUid ||
      (markerInfo.mode & 0o777) !== 0o600
    ) return { kind: "malformed" };
    const ownership: unknown = JSON.parse(await handle.readFile("utf8"));
    return scavengeOwnershipLooksValid(ownership)
      ? { kind: "valid", ownership }
      : { kind: "malformed" };
  } catch {
    return { kind: "malformed" };
  } finally {
    await handle.close();
  }
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

async function removeEmptyDirectoryWithIdentity(
  directory: string,
  numericUid: number,
  identity: DirectoryIdentity,
): Promise<void> {
  let current;
  try { current = await lstat(directory); } catch { return; }
  if (
    current.isSymbolicLink() || !current.isDirectory() || current.uid !== numericUid ||
    current.dev !== identity.dev || current.ino !== identity.ino
  ) return;
  await rmdir(directory).catch(() => {});
}

async function removeFinishedScavengeQuarantine(
  quarantineDir: string,
  numericUid: number,
  identity: DirectoryIdentity | undefined,
  ownership?: ScavengeOwnership,
): Promise<void> {
  if (!identity) return;
  let current;
  try { current = await lstat(quarantineDir); } catch { return; }
  if (
    current.isSymbolicLink() || !current.isDirectory() || current.uid !== numericUid ||
    current.dev !== identity.dev || current.ino !== identity.ino
  ) return;
  let entries: string[];
  try { entries = await readdir(quarantineDir); } catch { return; }
  if (ownership) {
    if (entries.length !== 1 || entries[0] !== SCAVENGE_OWNER_MANIFEST) return;
    const current = await readScavengeOwnership(quarantineDir, numericUid);
    if (
      current.kind !== "valid" || current.ownership.version !== ownership.version ||
      current.ownership.ownerPid !== ownership.ownerPid
    ) return;
    try { await unlink(path.join(quarantineDir, SCAVENGE_OWNER_MANIFEST)); } catch { return; }
  } else if (entries.length !== 0) {
    return;
  }
  await removeEmptyDirectoryWithIdentity(quarantineDir, numericUid, identity);
}

async function recoverScavengeQuarantines(options: {
  rootDir: string;
  entries: string[];
  prefix: string;
  quarantinePrefix: string;
  numericUid: number;
  nowMs: number;
  ttlMs: number;
  currentCwd: string;
  isProcessAlive: (pid: number) => boolean | Promise<boolean>;
  renameImpl: typeof rename;
}): Promise<void> {
  for (const entry of options.entries) {
    if (!entry.startsWith(options.quarantinePrefix)) continue;
    const quarantineDir = path.join(options.rootDir, entry);
    let quarantineInfo;
    try { quarantineInfo = await lstat(quarantineDir); } catch { continue; }
    if (
      quarantineInfo.isSymbolicLink() || !quarantineInfo.isDirectory() ||
      quarantineInfo.uid !== options.numericUid
    ) continue;

    const owner = await readScavengeOwnership(quarantineDir, options.numericUid);
    if (owner.kind === "malformed") continue;
    if (owner.kind === "valid") {
      let alive = true;
      try { alive = await options.isProcessAlive(owner.ownership.ownerPid); } catch { /* preserve */ }
      if (alive) continue;
    } else if (options.nowMs - quarantineInfo.mtimeMs <= options.ttlMs) {
      continue;
    }

    let children: string[];
    try { children = await readdir(quarantineDir); } catch { continue; }
    for (const childName of children) {
      if (childName === SCAVENGE_OWNER_MANIFEST) continue;
      if (!childName.startsWith(options.prefix)) continue;
      const child = path.join(quarantineDir, childName);
      if (pathContains(child, options.currentCwd)) continue;
      let childInfo;
      try { childInfo = await lstat(child); } catch { continue; }
      if (
        childInfo.isSymbolicLink() || !childInfo.isDirectory() ||
        childInfo.uid !== options.numericUid
      ) continue;
      const original = path.join(options.rootDir, childName);
      let reservation;
      try {
        await mkdir(original, { mode: 0o700 });
        reservation = await lstat(original);
        if (
          reservation.isSymbolicLink() || !reservation.isDirectory() ||
          reservation.uid !== options.numericUid
        ) continue;
      } catch {
        // mkdir is the no-overwrite claim: an occupied public path is always preserved.
        continue;
      }
      try {
        await options.renameImpl(child, original);
        const restored = await lstat(original);
        if (
          restored.isSymbolicLink() || !restored.isDirectory() || restored.uid !== options.numericUid ||
          restored.dev !== childInfo.dev || restored.ino !== childInfo.ino
        ) throw new Error("Recovered run identity changed during restoration.");
      } catch {
        await removeEmptyDirectoryWithIdentity(original, options.numericUid, reservation);
      }
    }
    await removeFinishedScavengeQuarantine(
      quarantineDir,
      options.numericUid,
      { dev: quarantineInfo.dev, ino: quarantineInfo.ino },
      owner.kind === "valid" ? owner.ownership : undefined,
    );
  }
}

export interface ScavengeReviewTempOptions {
  rootDir?: string;
  nowMs?: number;
  ttlMs?: number;
  currentCwd?: string;
  isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
  dependencies?: RemovalDependencies;
}

/** Best-effort same-UID recovery; linked admin entries require matching random-token proof. */
export async function scavengeStaleReviewTempWorkspaces(
  options: ScavengeReviewTempOptions = {},
): Promise<string[]> {
  const rootDir = options.rootDir ?? tmpdir();
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? REVIEW_TEMP_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Review temp TTL must be positive.");
  if (typeof process.getuid !== "function") return [];
  const numericUid = process.getuid();
  const uid = String(numericUid);
  const prefix = `pi-adversarial-review-${uid}-`;
  const quarantinePrefix = `pi-adversarial-review-scavenge-${uid}-`;
  const currentCwd = options.currentCwd ?? process.cwd();
  const isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
  const renameImpl = options.dependencies?.rename ?? rename;
  const removeTree = options.dependencies?.removeTree ?? removePlainTree;
  let entries: string[];
  try { entries = await readdir(rootDir); } catch { return []; }

  await recoverScavengeQuarantines({
    rootDir,
    entries,
    prefix,
    quarantinePrefix,
    numericUid,
    nowMs,
    ttlMs,
    currentCwd,
    isProcessAlive,
    renameImpl,
  });
  try { entries = await readdir(rootDir); } catch { return []; }

  let quarantine: string | undefined;
  let quarantineIdentity: DirectoryIdentity | undefined;
  let quarantineOwnership: ScavengeOwnership | undefined;
  const ensureQuarantine = async () => {
    if (quarantine && quarantineOwnership) return quarantine;
    const created = await mkdtemp(path.join(rootDir, quarantinePrefix));
    const ownership: ScavengeOwnership = {
      version: SCAVENGE_OWNER_VERSION,
      ownerPid: process.pid,
    };
    let createdIdentity: DirectoryIdentity | undefined;
    try {
      await chmod(created, 0o700);
      const createdInfo = await lstat(created);
      createdIdentity = { dev: createdInfo.dev, ino: createdInfo.ino };
      if (
        createdInfo.isSymbolicLink() || !createdInfo.isDirectory() ||
        createdInfo.uid !== numericUid
      ) throw new Error("Scavenger quarantine is not a same-UID real directory.");
      const markerPath = path.join(created, SCAVENGE_OWNER_MANIFEST);
      await (options.dependencies?.writeScavengeMarker ?? writeJsonAtomically)(markerPath, ownership);
      await chmod(markerPath, 0o600);
      const persisted = await readScavengeOwnership(created, numericUid);
      if (
        persisted.kind !== "valid" || persisted.ownership.ownerPid !== ownership.ownerPid
      ) throw new Error("Scavenger quarantine owner marker could not be verified.");
      quarantine = created;
      quarantineIdentity = createdIdentity;
      quarantineOwnership = ownership;
      return created;
    } catch (error) {
      const persisted = await readScavengeOwnership(created, numericUid);
      await removeFinishedScavengeQuarantine(
        created,
        numericUid,
        createdIdentity,
        persisted.kind === "valid" && persisted.ownership.ownerPid === ownership.ownerPid
          ? persisted.ownership
          : undefined,
      );
      throw error;
    }
  };
  const removed: string[] = [];
  try {
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const candidate = path.join(rootDir, entry);
      if (pathContains(candidate, currentCwd)) continue;
      let moved: string | undefined;
      try {
        const before = await lstat(candidate);
        if (
          before.isSymbolicLink() || !before.isDirectory() || before.uid !== numericUid ||
          nowMs - before.mtimeMs <= ttlMs
        ) continue;

        const manifestPath = path.join(candidate, OWNER_MANIFEST);
        let ownership: WorktreeOwnership | undefined;
        if (!(await pathMissing(manifestPath))) {
          ownership = await readJsonRegular<WorktreeOwnership>(manifestPath, numericUid);
          if (!manifestLooksValid(ownership, candidate)) {
            throw new Error("Stale ownership manifest is malformed or path-mismatched.");
          }
          if (ownership.state !== "completed" && await isProcessAlive(ownership.ownerPid)) continue;
        }

        moved = path.join(await ensureQuarantine(), entry);
        await renameImpl(candidate, moved);
        const after = await lstat(moved);
        if (
          after.dev !== before.dev || after.ino !== before.ino || after.isSymbolicLink() ||
          !after.isDirectory() || after.uid !== numericUid
        ) throw new Error("Stale run identity changed during quarantine.");

        const movedManifest = path.join(moved, OWNER_MANIFEST);
        const movedWorktree = path.join(moved, "worktree");
        const hasWorktree = !(await pathMissing(movedWorktree));
        const isWorktreeItself = !(await pathMissing(path.join(moved, ".git")));
        if (!ownership) {
          if (hasWorktree || isWorktreeItself) {
            throw new Error("Unproven linked worktree must be preserved.");
          }
          await removeTree(moved);
          removed.push(candidate);
          continue;
        }

        if (ownership.state === "workspace" || ownership.state === "completed") {
          if (hasWorktree || isWorktreeItself) {
            throw new Error("Workspace-only ownership cannot prove a linked worktree.");
          }
          if (ownership.state !== "completed") {
            ownership = completedOwnership(ownership);
            await writeJsonAtomically(movedManifest, ownership);
          }
        } else {
          if (hasWorktree) {
            const movedInfo = await lstat(movedWorktree);
            if (!movedInfo.isDirectory() || movedInfo.isSymbolicLink() || movedInfo.uid !== numericUid) {
              throw new Error("Quarantined checkout is not a same-UID real directory.");
            }
          }
          let registration: ProvenRegistration | undefined;
          if (ownership.state === "owned") {
            registration = await verifyOwnedRegistration(ownership, candidate, numericUid);
          } else if (ownership.state === "pending") {
            registration = await findPendingRegistration(ownership, numericUid);
            if (!registration) {
              if (hasWorktree && !(await pathMissing(path.join(movedWorktree, ".git")))) {
                throw new Error("Pending worktree has no token-proven exact registration.");
              }
              ownership = completedOwnership(ownership);
              await writeJsonAtomically(movedManifest, ownership);
            }
          }
          if (ownership.state !== "completed") {
            ownership = await isolateAndRemoveRegistration({
              ownership,
              ...(registration ? { registration } : {}),
              manifestPath: movedManifest,
              expectedRunDir: candidate,
              checkoutPath: movedWorktree,
              numericUid,
              dependencies: options.dependencies,
            });
          }
        }
        await removeTree(moved);
        removed.push(candidate);
      } catch {
        if (moved && !(await pathMissing(moved).catch(() => true))) {
          try {
            if (await pathMissing(candidate)) await renameImpl(moved, candidate);
          } catch {
            // Preserve the quarantined run if its exact public path cannot be restored.
          }
        }
      }
    }
  } finally {
    if (quarantine && quarantineOwnership) {
      await removeFinishedScavengeQuarantine(
        quarantine,
        numericUid,
        quarantineIdentity,
        quarantineOwnership,
      );
    }
  }
  return removed.sort((left, right) => left.localeCompare(right, "en"));
}

export interface CreateReviewTempWorkspaceOptions {
  rootDir?: string;
  dependencies?: RemovalDependencies;
}

export async function createReviewTempWorkspace(
  _runId: string,
  options: CreateReviewTempWorkspaceOptions = {},
): Promise<ReviewTempWorkspace> {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  const rootDir = options.rootDir ?? tmpdir();
  await scavengeStaleReviewTempWorkspaces({ rootDir });
  const runDir = await mkdtemp(path.join(rootDir, `pi-adversarial-review-${uid}-`));
  const inputPath = path.join(runDir, "input.md");
  const worktreeDir = path.join(runDir, "worktree");
  const hooksDir = path.join(runDir, "hooks");
  const manifestPath = path.join(runDir, OWNER_MANIFEST);
  await chmod(runDir, 0o700);
  let ownership: WorktreeOwnership = {
    version: OWNER_VERSION,
    state: "workspace",
    ownerPid: process.pid,
    runDir,
  };
  await writeJsonAtomically(manifestPath, ownership);
  await mkdir(hooksDir, { mode: 0o700 });

  let cleaned = false;
  const removeRunTree = options.dependencies?.removeTree ?? removePlainTree;
  return {
    runDir,
    inputPath,
    worktreeDir,
    async writeInput(content: string) {
      const handle = await open(inputPath, "w", 0o600);
      try { await handle.writeFile(content, "utf8"); } finally { await handle.close(); }
      await chmod(inputPath, 0o600);
    },
    async createRangeWorktree(createOptions) {
      if (ownership.state === "owned") return worktreeDir;
      if (ownership.state !== "workspace") {
        throw new ReviewInputError("Detached review worktree creation is already pending.");
      }
      const env = await hardenedWorktreeEnv(createOptions.root, hooksDir, createOptions.signal);
      const commonGitDir = path.resolve(createOptions.root, await runGit({
        root: createOptions.root,
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        env,
        signal: createOptions.signal,
        operation: "Resolve common Git directory",
      }));
      const token = randomBytes(32).toString("hex");
      await assertRangeCheckoutCapacity({
        tempPath: runDir,
        commonGitPath: commonGitDir,
        estimate: createOptions.estimate,
        ...(createOptions.dependencies ? { dependencies: createOptions.dependencies } : {}),
      });
      ownership = {
        version: OWNER_VERSION,
        state: "pending",
        token,
        ownerPid: process.pid,
        runDir,
        worktreePath: worktreeDir,
        commonGitDir,
        targetSha: createOptions.toSha,
      };
      await writeJsonAtomically(manifestPath, ownership);
      await runGit({
        root: createOptions.root,
        args: [
          "worktree", "add", "--detach", "--no-checkout", "--lock",
          "--reason", lockReason(token), worktreeDir, createOptions.toSha,
        ],
        env,
        signal: createOptions.signal,
        operation: "Create detached review worktree",
      });
      const dotGit = (await readRegular(path.join(worktreeDir, ".git"))).trim();
      const match = /^gitdir: (.+)$/u.exec(dotGit);
      if (!match?.[1]) {
        throw new ReviewInputError("Detached review worktree did not expose an exact Git admin path.");
      }
      const adminDir = path.resolve(worktreeDir, match[1]);
      const numericUid = typeof process.getuid === "function" ? process.getuid() : undefined;
      const registration = await verifyAdminRegistration(ownership, adminDir, numericUid);
      const marker: AdminMarker = { version: OWNER_VERSION, token, worktreePath: worktreeDir };
      await writeJsonAtomically(path.join(adminDir, ADMIN_MARKER), marker);
      const owned: OwnedWorktreeOwnership = {
        ...ownership,
        state: "owned",
        ...registration,
      };
      await writeJsonAtomically(manifestPath, owned);
      ownership = owned;
      const policy = resolvedPolicy(createOptions.dependencies?.policy);
      const statfsImpl = createOptions.dependencies?.statfs ?? statfs;
      await runGit({
        root: worktreeDir,
        args: ["reset", "--hard", "--no-recurse-submodules", createOptions.toSha],
        env,
        signal: createOptions.signal,
        operation: "Populate detached review worktree",
        monitorIntervalMs: createOptions.dependencies?.checkoutPollMs,
        monitor: async () => {
          const available = await availableFilesystemBytes(runDir, statfsImpl);
          if (available < policy.minFreeBytes) {
            throw new ReviewInputError(
              `Range checkout live free-space floor crossed: available=${available}, required=${policy.minFreeBytes} bytes.`,
            );
          }
        },
      });
      return worktreeDir;
    },
    async cleanup() {
      if (cleaned) return;
      const persisted = await readJsonRegular<WorktreeOwnership>(manifestPath);
      if (!manifestLooksValid(persisted, runDir)) {
        throw new ReviewInputError("Detached review workspace ownership manifest is malformed or path-mismatched.");
      }
      ownership = persisted;
      if (ownership.state === "completed") {
        await removeRunTree(runDir);
        cleaned = true;
        return;
      }
      if (ownership.state === "workspace") {
        if (!(await pathMissing(worktreeDir))) {
          throw new ReviewInputError(
            "Unproven detached review worktree was retained because ownership could not be established.",
          );
        }
        ownership = completedOwnership(ownership);
        await writeJsonAtomically(manifestPath, ownership);
        await removeRunTree(runDir);
        cleaned = true;
        return;
      }

      const numericUid = typeof process.getuid === "function" ? process.getuid() : undefined;
      let registration: ProvenRegistration | undefined;
      if (ownership.state === "owned") {
        try {
          registration = await verifyOwnedRegistration(ownership, runDir, numericUid);
        } catch (error) {
          if (!(await pathMissing(worktreeDir)) || !(await pathMissing(ownership.adminDir))) throw error;
          ownership = completedOwnership(ownership);
          await writeJsonAtomically(manifestPath, ownership);
        }
      } else if (ownership.state === "pending") {
        registration = await findPendingRegistration(ownership, numericUid);
        if (!registration) {
          if (!(await pathMissing(path.join(worktreeDir, ".git")))) {
            throw new ReviewInputError(
              "Unproven detached review worktree was retained because its token-locked registration was not found.",
            );
          }
          ownership = completedOwnership(ownership);
          await writeJsonAtomically(manifestPath, ownership);
        }
      }

      if (ownership.state === "pending" && registration) {
        ownership = await isolateAndRemoveRegistration({
          ownership,
          registration,
          manifestPath,
          expectedRunDir: runDir,
          checkoutPath: worktreeDir,
          numericUid,
          dependencies: options.dependencies,
        });
      } else if (ownership.state === "owned" && registration) {
        const checkoutMissing = await pathMissing(worktreeDir);
        if (checkoutMissing) {
          ownership = await isolateAndRemoveRegistration({
            ownership,
            registration,
            manifestPath,
            expectedRunDir: runDir,
            checkoutPath: worktreeDir,
            numericUid,
            dependencies: options.dependencies,
          });
        } else {
          await verifyCheckoutDotGit(worktreeDir, registration.adminDir, numericUid);
          const owned = ownership;
          const removing = removingOwnership(owned, registration);
          await writeJsonAtomically(manifestPath, removing);
          ownership = removing;
          const cleanupEnv = await hardenedWorktreeEnv(worktreeDir, hooksDir);
          try {
            await runGit({
              root: worktreeDir,
              args: ["worktree", "remove", "--force", "--force", worktreeDir],
              env: cleanupEnv,
              operation: "Remove detached review worktree",
            });
          } catch (error) {
            if (!(await pathMissing(registration.adminDir))) {
              await writeJsonAtomically(manifestPath, owned);
              ownership = owned;
              throw new ReviewInputError(
                `Detached review worktree removal failed; workspace and ownership manifest were retained: ${errorText(error)}`,
              );
            }
          }
          if (!(await pathMissing(registration.adminDir))) {
            await writeJsonAtomically(manifestPath, owned);
            ownership = owned;
            throw new ReviewInputError(
              `Detached review worktree admin entry remained after removal: ${registration.adminDir}. ` +
                "Workspace and ownership manifest were retained.",
            );
          }
          ownership = completedOwnership(removing);
          await writeJsonAtomically(manifestPath, ownership);
        }
      } else if (ownership.state === "registration-removing") {
        ownership = await isolateAndRemoveRegistration({
          ownership,
          manifestPath,
          expectedRunDir: runDir,
          checkoutPath: worktreeDir,
          numericUid,
          dependencies: options.dependencies,
        });
      }

      if (ownership.state !== "completed") {
        throw new ReviewInputError("Detached review workspace cleanup did not reach a completed state.");
      }
      await removeRunTree(runDir);
      cleaned = true;
    },
  };
}
