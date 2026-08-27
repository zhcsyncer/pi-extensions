import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAdversarialReviewConfigFile,
  loadAdversarialReviewConfig,
} from "../src/config.ts";

let root: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-adversarial-review-config-"));
  file = join(root, "config.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("adversarial review config", () => {
  it("uses the canonical user extension-data path and defaults to memory-only", () => {
    expect(getAdversarialReviewConfigFile(root)).toBe(
      join(root, "extension-data", "pi-adversarial-review", "config.json"),
    );
    expect(loadAdversarialReviewConfig(file)).toEqual({ persistRouteSessions: false });
  });

  it("enables persisted route sessions only through an explicit boolean", () => {
    writeFileSync(file, JSON.stringify({ persistRouteSessions: true }), "utf8");
    expect(loadAdversarialReviewConfig(file)).toEqual({ persistRouteSessions: true });
  });

  it.each([
    ["malformed JSON", "{not-json", "Invalid adversarial review config"],
    ["non-object root", "[]", "root must be a JSON object"],
    ["unknown field", JSON.stringify({ persistRoutes: true }), "unknown field"],
    ["wrong type", JSON.stringify({ persistRouteSessions: "yes" }), "must be a boolean"],
  ])("fails loud for %s", (_label, text, message) => {
    writeFileSync(file, text, "utf8");
    expect(() => loadAdversarialReviewConfig(file)).toThrow(message);
  });
});
