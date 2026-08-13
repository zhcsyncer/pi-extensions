import { spawn } from "node:child_process";
import { lstat, statfs } from "node:fs/promises";
import { ReviewInputError } from "./errors.ts";
import {
  INHERITED_GIT_CONTEXT_ENV_KEYS,
  neutralizedGitConfigEnv,
  type RangeCheckoutEstimate,
} from "./git-target.ts";

export const MAX_RANGE_CHECKOUT_ENTRIES = 100_000;
export const MAX_RANGE_CHECKOUT_LOGICAL_BYTES = 2n * 1024n * 1024n * 1024n;
export const MIN_RANGE_CHECKOUT_FREE_BYTES = 512n * 1024n * 1024n;
const RANGE_CHECKOUT_FREE_MULTIPLIER = 2n;
const COMMON_GIT_ADMIN_BASE_RESERVE_BYTES = 16n * 1024n * 1024n;
const COMMON_GIT_ADMIN_BYTES_PER_ENTRY = 256n;
const CHECKOUT_FREE_SPACE_POLL_MS = 50;

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

export async function createHardenedWorktreeEnv(
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

export async function runWorktreeGit(options: {
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
      monitorTimer = setInterval(
        () => { void poll(); },
        options.monitorIntervalMs ?? CHECKOUT_FREE_SPACE_POLL_MS,
      );
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

export function createRangeCheckoutMonitor(
  target: string,
  dependencies?: RangeCheckoutDependencies,
): () => Promise<void> {
  const policy = resolvedPolicy(dependencies?.policy);
  const statfsImpl = dependencies?.statfs ?? statfs;
  return async () => {
    const available = await availableFilesystemBytes(target, statfsImpl);
    if (available < policy.minFreeBytes) {
      throw new ReviewInputError(
        `Range checkout live free-space floor crossed: available=${available}, required=${policy.minFreeBytes} bytes.`,
      );
    }
  };
}
