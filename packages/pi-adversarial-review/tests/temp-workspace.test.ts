import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  scavengeStaleReviewTempWorkspaces,
} from "../src/input/temp-workspace.ts";

const roots: string[] = [];

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("review temp workspace scavenger", () => {
  it("removes only stale same-UID directories and never follows symlinks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-adversarial-ttl-test-"));
    roots.push(root);
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
    const prefix = `pi-adversarial-review-${uid}-`;
    const stale = path.join(root, `${prefix}stale`);
    const fresh = path.join(root, `${prefix}fresh`);
    const unrelated = path.join(root, "pi-adversarial-review-other-stale");
    const victim = path.join(root, "victim");
    const linked = path.join(root, `${prefix}linked`);
    for (const directory of [stale, fresh, unrelated, victim]) {
      await mkdir(directory);
      await writeFile(path.join(directory, "input.md"), "data");
    }
    await symlink(victim, linked, "dir");

    const nowMs = Date.now();
    const staleDate = new Date(nowMs - 1_001);
    await utimes(stale, staleDate, staleDate);
    await utimes(unrelated, staleDate, staleDate);
    await chmod(stale, 0o500);
    await chmod(path.join(stale, "input.md"), 0o400);

    await expect(scavengeStaleReviewTempWorkspaces({
      rootDir: root,
      nowMs,
      ttlMs: 1_000,
    })).resolves.toEqual([stale]);

    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(unrelated)).toBe(true);
    expect(await exists(linked)).toBe(true);
    expect(await exists(path.join(victim, "input.md"))).toBe(true);
    expect((await readdir(root)).some((entry) => entry.includes("-scavenge-"))).toBe(false);
  });

  it("is best-effort for missing roots and rejects invalid TTL configuration", async () => {
    await expect(scavengeStaleReviewTempWorkspaces({
      rootDir: "/definitely/missing/pi-adversarial-review",
      ttlMs: 1_000,
    })).resolves.toEqual([]);
    await expect(scavengeStaleReviewTempWorkspaces({ ttlMs: 0 })).rejects.toThrow(
      "Review temp TTL must be positive",
    );
  });
});
