import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getCacheDir, resetCacheDirForTests } from "../src/utils/cache-dir.js";

const originalEnvironment = {
  PI_CURSOR_CACHE_DIR: process.env.PI_CURSOR_CACHE_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
};
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetCacheDirForTests();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Cursor cache directory", () => {
  it("uses PI_CURSOR_CACHE_DIR as its explicit override", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-cursor-cache-contract-"));
    temporaryDirectories.push(root);
    const override = join(root, "override");
    process.env.PI_CURSOR_CACHE_DIR = override;
    process.env.XDG_CACHE_HOME = join(root, "xdg");
    resetCacheDirForTests();

    expect(getCacheDir()).toBe(override);
  });

  it("defaults to ~/.cache/pi-cursor via XDG_CACHE_HOME", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-cursor-xdg-"));
    temporaryDirectories.push(root);
    delete process.env.PI_CURSOR_CACHE_DIR;
    process.env.XDG_CACHE_HOME = root;
    resetCacheDirForTests();

    expect(getCacheDir()).toBe(join(root, "pi-cursor"));
  });
});
