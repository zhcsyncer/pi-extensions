import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getCacheDir, resetCacheDirForTests } from "../src/utils/cache-dir.js";

const originalEnvironment = {
  PI_CURSOR_ASK_CACHE_DIR: process.env.PI_CURSOR_ASK_CACHE_DIR,
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

describe("Cursor Ask cache identity", () => {
  it("uses only PI_CURSOR_ASK_CACHE_DIR as its explicit override", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-cursor-ask-cache-contract-"));
    temporaryDirectories.push(root);
    const officialCache = join(root, "official");
    const askCache = join(root, "ask");
    process.env.PI_CURSOR_CACHE_DIR = officialCache;
    process.env.PI_CURSOR_ASK_CACHE_DIR = askCache;
    resetCacheDirForTests();

    expect(getCacheDir()).toBe(askCache);
    expect(getCacheDir()).not.toBe(officialCache);
  });

  it("defaults to an isolated pi-cursor-ask directory", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-cursor-ask-xdg-"));
    temporaryDirectories.push(root);
    delete process.env.PI_CURSOR_ASK_CACHE_DIR;
    process.env.PI_CURSOR_CACHE_DIR = join(root, "official");
    process.env.XDG_CACHE_HOME = root;
    resetCacheDirForTests();

    expect(getCacheDir()).toBe(join(root, "pi-cursor-ask"));
  });
});
