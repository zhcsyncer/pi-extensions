import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  getGlobalAgentToolDescriptionPath,
  getLegacyGlobalAgentToolDescriptionPath,
  getLegacyProjectAgentToolDescriptionPath,
  getProjectAgentToolDescriptionPath,
} from "./config-paths.js";

export interface NormalizedJsonConfig<T> {
  value: T;
  dropped: string[];
}

export type JsonConfigNormalizer<T> = (raw: unknown) => NormalizedJsonConfig<T>;

interface JsonRead<T> {
  ok: true;
  value: T;
  dropped: string[];
}

interface FailedRead {
  ok: false;
  reason: string;
}

type ReadResult<T> = JsonRead<T> | FailedRead;
type TextRead = { ok: true; value: string } | FailedRead;

const emittedConfigNotices = new Set<string>();
const LOCK_FILE_PREFIX = ".config-migration.lock.";
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 1_000;
const LOCK_RETRY_MS = 20;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emitConfigNotice(message: string): void {
  if (emittedConfigNotices.has(message)) return;
  emittedConfigNotices.add(message);
  console.warn(message);
}

function droppedSummary(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  const unique = [...new Set(paths)];
  const shown = unique.slice(0, 8).join(", ");
  return ` Dropped ${unique.length} invalid or unknown field${unique.length === 1 ? "" : "s"}: ${shown}${unique.length > 8 ? ", …" : ""}.`;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

interface LockCandidate {
  name: string;
  ticket: bigint;
}

function readLockTicket(path: string): bigint {
  try {
    const metadata = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(metadata) && typeof metadata.ticket === "string" ? BigInt(metadata.ticket) : 0n;
  } catch {
    // An incomplete or malformed fresh candidate blocks safely.
    return 0n;
  }
}

function lockOwnerIsAlive(name: string): boolean {
  const rawPid = name.slice(LOCK_FILE_PREFIX.length).split(".", 1)[0];
  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isRecord(error) && error.code === "ESRCH");
  }
}

function activeLockCandidates(directory: string, ownName: string, now: number): LockCandidate[] {
  const candidates: LockCandidate[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(LOCK_FILE_PREFIX)) continue;
    const path = join(directory, name);
    try {
      if (
        name !== ownName &&
        now - statSync(path).mtimeMs > LOCK_STALE_MS &&
        !lockOwnerIsAlive(name)
      ) {
        // Candidate names contain a UUID and are never reused. Reclaim only
        // after its PID is gone, so a paused owner cannot resume concurrently.
        unlinkSync(path);
        continue;
      }
      candidates.push({ name, ticket: readLockTicket(path) });
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return candidates.sort((left, right) =>
    left.ticket < right.ticket ? -1 : left.ticket > right.ticket ? 1 : left.name.localeCompare(right.name),
  );
}

function withConfigLock<T>(directory: string, fn: () => T): T {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockName = `${LOCK_FILE_PREFIX}${process.pid}.${randomUUID()}`;
  const lockPath = join(directory, lockName);
  const descriptor = openSync(lockPath, "wx", 0o600);
  const ticket = process.hrtime.bigint();
  try {
    writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, ticket: ticket.toString(), createdAt: new Date().toISOString() })}\n`,
    );
  } catch (error) {
    closeSync(descriptor);
    rmSync(lockPath, { force: true });
    throw error;
  }
  closeSync(descriptor);
  const deadline = Date.now() + LOCK_WAIT_MS;

  try {
    // Let simultaneously created candidates enter the same deterministic
    // election before the oldest monotonic ticket starts the critical section.
    sleepSync(LOCK_RETRY_MS);
    while (true) {
      const candidates = activeLockCandidates(directory, lockName, Date.now());
      if (candidates[0]?.name === lockName) return fn();
      if (Date.now() >= deadline) throw new Error(`timed out waiting for config lock in ${directory}`);
      sleepSync(LOCK_RETRY_MS);
    }
  } finally {
    rmSync(lockPath, { force: true });
  }
}

function writeAtomically(path: string, content: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function serializeNormalizedJson<T>(value: T, normalize: JsonConfigNormalizer<T>, path: string): string {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new Error(`could not serialize ${path} as JSON`);
  const content = `${serialized}\n`;
  let roundTrip: T;
  try {
    roundTrip = normalize(JSON.parse(content) as unknown).value;
  } catch (error) {
    throw new Error(
      `semantic round-trip verification failed before publishing ${path} (${errorMessage(error)})`,
      { cause: error },
    );
  }
  if (!isDeepStrictEqual(value, roundTrip)) {
    throw new Error(`semantic round-trip verification failed before publishing ${path}`);
  }
  return content;
}

function publishVerified<T>(path: string, content: string, verify: () => T): T {
  const previous = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  let published = false;
  try {
    writeAtomically(path, content);
    published = true;
    return verify();
  } catch (error) {
    if (!published) throw error;
    try {
      if (previous === undefined) rmSync(path, { force: true });
      else writeAtomically(path, previous);
    } catch (rollbackError) {
      throw new Error(
        `${errorMessage(error)}; could not restore the previous canonical file (${errorMessage(rollbackError)})`,
        { cause: error },
      );
    }
    throw error;
  }
}

function readJsonConfig<T>(path: string, normalize: JsonConfigNormalizer<T>): ReadResult<T> {
  try {
    const normalized = normalize(JSON.parse(readFileSync(path, "utf8")) as unknown);
    return { ok: true, value: normalized.value, dropped: normalized.dropped };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

function readTextConfig(path: string): TextRead {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value
      ? { ok: true, value }
      : { ok: false, reason: "the file is empty" };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

function reconcileJsonLegacy<T>(options: {
  canonicalPath: string;
  legacyPath: string;
  scope: string;
  canonical: T;
  normalize: JsonConfigNormalizer<T>;
}): void {
  const { canonicalPath, legacyPath, scope, canonical, normalize } = options;
  if (!existsSync(legacyPath)) return;
  const legacy = readJsonConfig(legacyPath, normalize);
  if (!legacy.ok) {
    emitConfigNotice(
      `[pi-subagents] Legacy ${scope} at ${legacyPath} is unreadable or malformed (${legacy.reason}); ` +
      `canonical config at ${canonicalPath} remains active and the legacy file was preserved.`,
    );
    return;
  }
  if (!isDeepStrictEqual(canonical, legacy.value)) {
    emitConfigNotice(
      `[pi-subagents] Ignoring conflicting legacy ${scope} at ${legacyPath}; canonical config is ${canonicalPath}. ` +
      "The legacy file was preserved.",
    );
    return;
  }
  const verified = readJsonConfig(canonicalPath, normalize);
  if (!verified.ok || !isDeepStrictEqual(canonical, verified.value)) {
    emitConfigNotice(
      `[pi-subagents] Could not semantically re-read canonical ${scope} at ${canonicalPath}; ` +
      `equivalent legacy file at ${legacyPath} was preserved.`,
    );
    return;
  }
  try {
    unlinkSync(legacyPath);
    emitConfigNotice(
      `[pi-subagents] Removed equivalent legacy ${scope} at ${legacyPath}; canonical config is ${canonicalPath}.` +
      droppedSummary(legacy.dropped),
    );
  } catch (error) {
    emitConfigNotice(
      `[pi-subagents] Could not remove equivalent legacy ${scope} at ${legacyPath} (${errorMessage(error)}); ` +
      "the canonical file remains active and the legacy file was preserved.",
    );
  }
}

function readCanonicalJson<T>(options: {
  canonicalPath: string;
  scope: string;
  normalize: JsonConfigNormalizer<T>;
  fallback: T;
}): T {
  const canonical = readJsonConfig(options.canonicalPath, options.normalize);
  if (canonical.ok) return canonical.value;
  emitConfigNotice(
    `[pi-subagents] Could not read canonical ${options.scope} at ${options.canonicalPath} (${canonical.reason}); ` +
    "legacy config was not used or removed.",
  );
  return options.fallback;
}

function loadJsonUnderLock<T>(options: {
  canonicalPath: string;
  legacyPath: string;
  scope: string;
  normalize: JsonConfigNormalizer<T>;
  fallback: T;
}): T {
  const { canonicalPath, legacyPath, scope, normalize, fallback } = options;
  if (existsSync(canonicalPath)) {
    const canonical = readJsonConfig(canonicalPath, normalize);
    if (!canonical.ok) {
      emitConfigNotice(
        `[pi-subagents] Could not read canonical ${scope} at ${canonicalPath} (${canonical.reason}); ` +
        "legacy config was not used or removed.",
      );
      return fallback;
    }
    reconcileJsonLegacy({ canonicalPath, legacyPath, scope, canonical: canonical.value, normalize });
    return canonical.value;
  }
  if (!existsSync(legacyPath)) return fallback;

  const legacy = readJsonConfig(legacyPath, normalize);
  if (!legacy.ok) {
    emitConfigNotice(
      `[pi-subagents] Legacy ${scope} at ${legacyPath} is unreadable or malformed (${legacy.reason}); ` +
      "it was preserved.",
    );
    return fallback;
  }

  const content = serializeNormalizedJson(legacy.value, normalize, canonicalPath);
  const verified = publishVerified(canonicalPath, content, () => {
    const reread = readJsonConfig(canonicalPath, normalize);
    if (!reread.ok || !isDeepStrictEqual(legacy.value, reread.value)) {
      throw new Error(`semantic round-trip verification failed for ${canonicalPath}`);
    }
    return reread;
  });
  unlinkSync(legacyPath);
  emitConfigNotice(
    `[pi-subagents] Migrated ${scope} from ${legacyPath} to ${canonicalPath}.` + droppedSummary(legacy.dropped),
  );
  return verified.value;
}

export function loadMigratedJsonConfig<T>(options: {
  canonicalPath: string;
  legacyPath: string;
  scope: string;
  normalize: JsonConfigNormalizer<T>;
  fallback: T;
}): T {
  const { canonicalPath, legacyPath } = options;
  if (existsSync(canonicalPath)) {
    if (!existsSync(legacyPath)) return readCanonicalJson(options);
  } else if (!existsSync(legacyPath)) {
    // A competing migrator publishes canonical before deleting legacy. Recheck
    // before treating the transition as an empty configuration.
    if (existsSync(canonicalPath)) return readCanonicalJson(options);
    return options.fallback;
  }

  try {
    return withConfigLock(dirname(canonicalPath), () => loadJsonUnderLock(options));
  } catch (error) {
    emitConfigNotice(
      `[pi-subagents] Failed to migrate or reconcile ${options.scope} at ${canonicalPath} (${errorMessage(error)}); ` +
      "the legacy file was preserved.",
    );
    if (existsSync(canonicalPath)) return readCanonicalJson(options);
    if (existsSync(legacyPath)) {
      const legacy = readJsonConfig(legacyPath, options.normalize);
      if (legacy.ok) return legacy.value;
    }
    // A competing migrator publishes canonical before deleting legacy. Recheck
    // after a missing legacy read so that transition cannot look like no config.
    if (existsSync(canonicalPath)) return readCanonicalJson(options);
    return options.fallback;
  }
}

export function saveJsonConfig<T>(options: {
  canonicalPath: string;
  value: unknown;
  normalize: JsonConfigNormalizer<T>;
}): boolean {
  try {
    return withConfigLock(dirname(options.canonicalPath), () => {
      const normalized = options.normalize(options.value).value;
      const content = serializeNormalizedJson(normalized, options.normalize, options.canonicalPath);
      publishVerified(options.canonicalPath, content, () => {
        const verified = readJsonConfig(options.canonicalPath, options.normalize);
        if (!verified.ok || !isDeepStrictEqual(normalized, verified.value)) {
          throw new Error(`semantic round-trip verification failed for ${options.canonicalPath}`);
        }
      });
      return true;
    });
  } catch {
    return false;
  }
}

function reconcileTextLegacy(options: {
  canonicalPath: string;
  legacyPath: string;
  scope: string;
  canonical: string;
}): void {
  const { canonicalPath, legacyPath, scope, canonical } = options;
  if (!existsSync(legacyPath)) return;
  const legacy = readTextConfig(legacyPath);
  if (!legacy.ok) {
    emitConfigNotice(
      `[pi-subagents] Legacy ${scope} at ${legacyPath} is unreadable or malformed (${legacy.reason}); ` +
      `canonical config at ${canonicalPath} remains active and the legacy file was preserved.`,
    );
    return;
  }
  if (canonical !== legacy.value) {
    emitConfigNotice(
      `[pi-subagents] Ignoring conflicting legacy ${scope} at ${legacyPath}; canonical config is ${canonicalPath}. ` +
      "The legacy file was preserved.",
    );
    return;
  }
  const verified = readTextConfig(canonicalPath);
  if (!verified.ok || verified.value !== canonical) {
    emitConfigNotice(
      `[pi-subagents] Could not semantically re-read canonical ${scope} at ${canonicalPath}; ` +
      `equivalent legacy file at ${legacyPath} was preserved.`,
    );
    return;
  }
  try {
    unlinkSync(legacyPath);
    emitConfigNotice(
      `[pi-subagents] Removed equivalent legacy ${scope} at ${legacyPath}; canonical config is ${canonicalPath}.`,
    );
  } catch (error) {
    emitConfigNotice(
      `[pi-subagents] Could not remove equivalent legacy ${scope} at ${legacyPath} (${errorMessage(error)}); ` +
      "the canonical file remains active and the legacy file was preserved.",
    );
  }
}

function readCanonicalText(canonicalPath: string, scope: string): string | undefined {
  const canonical = readTextConfig(canonicalPath);
  if (canonical.ok) return canonical.value;
  emitConfigNotice(
    `[pi-subagents] Could not read canonical ${scope} at ${canonicalPath} (${canonical.reason}); ` +
    "legacy config was not used or removed.",
  );
  return undefined;
}

function loadTextUnderLock(options: {
  canonicalPath: string;
  legacyPath: string;
  scope: string;
}): string | undefined {
  const { canonicalPath, legacyPath, scope } = options;
  if (existsSync(canonicalPath)) {
    const canonical = readTextConfig(canonicalPath);
    if (!canonical.ok) {
      emitConfigNotice(
        `[pi-subagents] Could not read canonical ${scope} at ${canonicalPath} (${canonical.reason}); ` +
        "legacy config was not used or removed.",
      );
      return undefined;
    }
    reconcileTextLegacy({ canonicalPath, legacyPath, scope, canonical: canonical.value });
    return canonical.value;
  }
  if (!existsSync(legacyPath)) return undefined;

  const legacy = readTextConfig(legacyPath);
  if (!legacy.ok) {
    emitConfigNotice(
      `[pi-subagents] Legacy ${scope} at ${legacyPath} is unreadable or malformed (${legacy.reason}); ` +
      "it was preserved.",
    );
    return undefined;
  }

  const verified = publishVerified(canonicalPath, `${legacy.value}\n`, () => {
    const reread = readTextConfig(canonicalPath);
    if (!reread.ok || reread.value !== legacy.value) {
      throw new Error(`semantic round-trip verification failed for ${canonicalPath}`);
    }
    return reread;
  });
  unlinkSync(legacyPath);
  emitConfigNotice(`[pi-subagents] Migrated ${scope} from ${legacyPath} to ${canonicalPath}.`);
  return verified.value;
}

export function loadMigratedTextConfig(options: {
  canonicalPath: string;
  legacyPath: string;
  scope: string;
}): string | undefined {
  const { canonicalPath, legacyPath, scope } = options;
  if (existsSync(canonicalPath)) {
    if (!existsSync(legacyPath)) return readCanonicalText(canonicalPath, scope);
  } else if (!existsSync(legacyPath)) {
    // A competing migrator publishes canonical before deleting legacy. Recheck
    // before treating the transition as an absent text configuration.
    if (existsSync(canonicalPath)) return readCanonicalText(canonicalPath, scope);
    return undefined;
  }

  try {
    return withConfigLock(dirname(canonicalPath), () => loadTextUnderLock(options));
  } catch (error) {
    emitConfigNotice(
      `[pi-subagents] Failed to migrate or reconcile ${scope} at ${canonicalPath} (${errorMessage(error)}); ` +
      "the legacy file was preserved.",
    );
    if (existsSync(canonicalPath)) return readCanonicalText(canonicalPath, scope);
    if (existsSync(legacyPath)) {
      const legacy = readTextConfig(legacyPath);
      if (legacy.ok) return legacy.value;
    }
    // A competing migrator publishes canonical before deleting legacy. Recheck
    // after a missing legacy read so that transition cannot look like no config.
    if (existsSync(canonicalPath)) return readCanonicalText(canonicalPath, scope);
    return undefined;
  }
}

/** Project override wins over global, matching the settings precedence. */
export function loadAgentToolDescriptionConfig(cwd: string = process.cwd()): string | undefined {
  const project = loadMigratedTextConfig({
    canonicalPath: getProjectAgentToolDescriptionPath(cwd),
    legacyPath: getLegacyProjectAgentToolDescriptionPath(cwd),
    scope: "project agent tool description",
  });
  if (project !== undefined) return project;
  return loadMigratedTextConfig({
    canonicalPath: getGlobalAgentToolDescriptionPath(),
    legacyPath: getLegacyGlobalAgentToolDescriptionPath(),
    scope: "global agent tool description",
  });
}

export function emitSubagentsConfigNotice(message: string): void {
  emitConfigNotice(message);
}

export function resetSubagentsConfigNoticesForTests(): void {
  emittedConfigNotices.clear();
}
