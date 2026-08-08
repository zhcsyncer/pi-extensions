import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const REVIEW_TEMP_TTL_MS = 24 * 60 * 60_000;

export interface ReviewTempWorkspace {
  runDir: string;
  inputPath: string;
  snapshotDir: string;
  writeInput(content: string): Promise<void>;
  makeSnapshotReadOnly(): Promise<void>;
  cleanup(): Promise<void>;
}

async function makeTreeReadOnly(target: string): Promise<void> {
  const info = await lstat(target);
  if (info.isSymbolicLink()) return;
  if (!info.isDirectory()) {
    await chmod(target, info.mode & 0o111 ? 0o555 : 0o444);
    return;
  }
  for (const entry of await readdir(target)) {
    await makeTreeReadOnly(path.join(target, entry));
  }
  await chmod(target, 0o555);
}

async function makeTreeRemovable(target: string): Promise<void> {
  let info;
  try {
    info = await lstat(target);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) return;
  if (!info.isDirectory()) {
    await chmod(target, 0o600);
    return;
  }
  await chmod(target, 0o700);
  for (const entry of await readdir(target)) {
    await makeTreeRemovable(path.join(target, entry));
  }
}

export interface ScavengeReviewTempOptions {
  rootDir?: string;
  nowMs?: number;
  ttlMs?: number;
}

/** Best-effort cleanup of old same-UID workspaces without following symlinks. */
export async function scavengeStaleReviewTempWorkspaces(
  options: ScavengeReviewTempOptions = {},
): Promise<string[]> {
  const rootDir = options.rootDir ?? tmpdir();
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? REVIEW_TEMP_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Review temp TTL must be positive.");

  // On platforms without a numeric owner identity, a shared temp directory
  // cannot be scavenged without risking another user's workspace.
  if (typeof process.getuid !== "function") return [];
  const numericUid = process.getuid();
  const uid = String(numericUid);
  const prefix = `pi-adversarial-review-${uid}-`;
  let entries: string[];
  try {
    entries = await readdir(rootDir);
  } catch {
    return [];
  }

  let quarantine: string | undefined;
  let quarantineHasPreservedEntry = false;
  const ensureQuarantine = async () => {
    if (quarantine) return quarantine;
    quarantine = await mkdtemp(path.join(rootDir, `pi-adversarial-review-scavenge-${uid}-`));
    await chmod(quarantine, 0o700);
    return quarantine;
  };

  const removed: string[] = [];
  try {
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const candidate = path.join(rootDir, entry);
      try {
        const before = await lstat(candidate);
        if (
          before.isSymbolicLink() ||
          !before.isDirectory() ||
          before.uid !== numericUid ||
          nowMs - before.mtimeMs <= ttlMs
        ) continue;

        // Rename first. All permission changes and recursive traversal then occur
        // below a private quarantine path rather than the attacker-visible name.
        const moved = path.join(await ensureQuarantine(), entry);
        await rename(candidate, moved);
        const after = await lstat(moved);
        if (
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.isSymbolicLink() ||
          !after.isDirectory() ||
          after.uid !== numericUid
        ) {
          quarantineHasPreservedEntry = true;
          continue;
        }
        await makeTreeRemovable(moved);
        await rm(moved, { recursive: true, force: true });
        removed.push(candidate);
      } catch {
        // Another process may have removed or exchanged it. Never follow the
        // old public path after an identity-changing race.
      }
    }
  } finally {
    if (quarantine && !quarantineHasPreservedEntry) {
      await rm(quarantine, { recursive: true, force: true }).catch(() => {});
    }
  }
  return removed.sort((left, right) => left.localeCompare(right, "en"));
}

export async function createReviewTempWorkspace(_runId: string): Promise<ReviewTempWorkspace> {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  await scavengeStaleReviewTempWorkspaces();
  // runId is report metadata, never a filesystem path component. mkdtemp gives
  // exclusive creation even if a caller supplies a malicious or repeated id.
  const runDir = await mkdtemp(path.join(tmpdir(), `pi-adversarial-review-${uid}-`));
  const inputPath = path.join(runDir, "input.md");
  const snapshotDir = path.join(runDir, "snapshot");

  await chmod(runDir, 0o700);
  await mkdir(snapshotDir, { mode: 0o700 });

  let cleaned = false;
  return {
    runDir,
    inputPath,
    snapshotDir,
    async writeInput(content: string) {
      await writeFile(inputPath, content, { encoding: "utf8", mode: 0o600 });
      await chmod(inputPath, 0o600);
    },
    async makeSnapshotReadOnly() {
      await makeTreeReadOnly(snapshotDir);
    },
    async cleanup() {
      if (cleaned) return;
      await makeTreeRemovable(runDir);
      await rm(runDir, { recursive: true, force: true });
      cleaned = true;
    },
  };
}
