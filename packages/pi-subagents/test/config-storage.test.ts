import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadMigratedJsonConfig,
  type NormalizedJsonConfig,
  resetSubagentsConfigNoticesForTests,
  saveJsonConfig,
} from "../src/config-storage.js";

interface NumericConfig {
  value: number;
}

function normalizeNumeric(raw: unknown): NormalizedJsonConfig<NumericConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof (raw as Record<string, unknown>).value !== "number") {
    throw new Error("value must be a number");
  }
  return { value: raw as NumericConfig, dropped: [] };
}

describe("config storage publication safety", () => {
  let root: string;
  let canonicalPath: string;
  let legacyPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-subagents-config-storage-"));
    canonicalPath = join(root, "canonical", "config.json");
    legacyPath = join(root, "legacy.json");
    resetSubagentsConfigNoticesForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSubagentsConfigNoticesForTests();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps legacy as the runtime fallback when JSON cannot round-trip before publish", () => {
    writeFileSync(legacyPath, '{"value":1e400}\n', "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      loadMigratedJsonConfig({
        canonicalPath,
        legacyPath,
        scope: "test settings",
        normalize: normalizeNumeric,
        fallback: { value: 0 },
      }),
    ).toEqual({ value: Number.POSITIVE_INFINITY });
    expect(existsSync(canonicalPath)).toBe(false);
    expect(existsSync(legacyPath)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("before publishing"));
  });

  it("does not replace an existing canonical file when pre-publish verification fails", () => {
    const original = '{"value":7}\n';
    mkdirSync(dirname(canonicalPath), { recursive: true });
    writeFileSync(canonicalPath, original, "utf8");

    expect(
      saveJsonConfig({
        canonicalPath,
        value: { value: Number.POSITIVE_INFINITY },
        normalize: normalizeNumeric,
      }),
    ).toBe(false);
    expect(readFileSync(canonicalPath, "utf8")).toBe(original);
  });

  it("restores the previous canonical file when the post-publish semantic read fails", () => {
    const original = '{"value":7}\n';
    mkdirSync(dirname(canonicalPath), { recursive: true });
    writeFileSync(canonicalPath, original, "utf8");
    let normalizations = 0;
    const failPublishedRead = (raw: unknown): NormalizedJsonConfig<NumericConfig> => {
      normalizations += 1;
      const normalized = normalizeNumeric(raw);
      return normalizations === 3 ? { value: { value: 99 }, dropped: [] } : normalized;
    };

    expect(
      saveJsonConfig({
        canonicalPath,
        value: { value: 8 },
        normalize: failPublishedRead,
      }),
    ).toBe(false);
    expect(readFileSync(canonicalPath, "utf8")).toBe(original);
  });

  it("never reclaims an expired-looking lock while its owner PID is alive", () => {
    writeFileSync(legacyPath, '{"value":3}\n', "utf8");
    const lockPath = join(dirname(canonicalPath), `.config-migration.lock.${process.pid}.existing`);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "existing owner\n", "utf8");
    const now = Date.now();
    const expiredAt = new Date(now - 31_000);
    utimesSync(lockPath, expiredAt, expiredAt);
    vi.spyOn(Date, "now").mockReturnValueOnce(now).mockReturnValue(now + 1_001);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      loadMigratedJsonConfig({
        canonicalPath,
        legacyPath,
        scope: "test settings",
        normalize: normalizeNumeric,
        fallback: { value: 0 },
      }),
    ).toEqual({ value: 3 });
    expect(readFileSync(lockPath, "utf8")).toBe("existing owner\n");
    expect(existsSync(canonicalPath)).toBe(false);
    expect(existsSync(legacyPath)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out waiting"));
  });

  it("safely removes an expired unique lock before restarting migration", () => {
    writeFileSync(legacyPath, '{"value":3}\n', "utf8");
    const lockPath = join(dirname(canonicalPath), ".config-migration.lock.999999.expired");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "expired owner\n", "utf8");
    const expiredAt = new Date(Date.now() - 31_000);
    utimesSync(lockPath, expiredAt, expiredAt);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      loadMigratedJsonConfig({
        canonicalPath,
        legacyPath,
        scope: "test settings",
        normalize: normalizeNumeric,
        fallback: { value: 0 },
      }),
    ).toEqual({ value: 3 });
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(legacyPath)).toBe(false);
    expect(readdirSync(dirname(canonicalPath))).toEqual(["config.json"]);
  });
});
