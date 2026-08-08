import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

export async function createReviewTempWorkspace(_runId: string): Promise<ReviewTempWorkspace> {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
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
