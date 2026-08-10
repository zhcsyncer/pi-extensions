import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAdversarialReviewAuditDir,
  persistStandaloneAudit,
} from "../src/output/audit-store.ts";

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-review-audit-store-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe("standalone adversarial review audit store", () => {
  it("atomically writes a private structured record under the Pi agent dir", () => {
    const path = persistStandaloneAudit({
      kind: "error",
      mode: "print",
      payload: { message: "failed" },
      sessionId: "session-1",
      cwd: "/repo",
      now: new Date("2026-01-02T03:04:05.000Z"),
      id: "audit-1",
      agentDir,
    });

    expect(path).toBe(join(
      getAdversarialReviewAuditDir(agentDir),
      "2026-01-02T03-04-05.000Z-error-audit-1.json",
    ));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      kind: "error",
      recordedAt: "2026-01-02T03:04:05.000Z",
      mode: "print",
      sessionId: "session-1",
      cwd: "/repo",
      payload: { message: "failed" },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(path))).toEqual(["2026-01-02T03-04-05.000Z-error-audit-1.json"]);
  });

  it("never overwrites an existing audit record", () => {
    const options = {
      kind: "report" as const,
      mode: "json" as const,
      payload: { runId: "run-1" },
      now: new Date("2026-01-02T03:04:05.000Z"),
      id: "same-id",
      agentDir,
    };
    const path = persistStandaloneAudit(options);

    expect(() => persistStandaloneAudit({ ...options, payload: { runId: "run-2" } })).toThrow();
    expect(JSON.parse(readFileSync(path, "utf8")).payload).toEqual({ runId: "run-1" });
    expect(readdirSync(dirname(path))).toEqual(["2026-01-02T03-04-05.000Z-report-same-id.json"]);
  });

  it("rejects a symlink in place of the audit directory", () => {
    const auditDir = getAdversarialReviewAuditDir(agentDir);
    const target = join(agentDir, "redirected");
    mkdirSync(dirname(auditDir), { recursive: true });
    mkdirSync(target);
    symlinkSync(target, auditDir, "dir");

    expect(() => persistStandaloneAudit({
      kind: "error",
      mode: "rpc",
      payload: {},
      agentDir,
    })).toThrow("audit path contains a non-directory or symlink");
    expect(readdirSync(target)).toEqual([]);
  });

  it("rejects a symlink in any extension-owned ancestor directory", () => {
    const extensionData = join(agentDir, "extension-data");
    const packageData = join(extensionData, "pi-adversarial-review");
    const target = join(agentDir, "redirected-package-data");
    mkdirSync(extensionData);
    mkdirSync(target);
    symlinkSync(target, packageData, "dir");

    expect(() => persistStandaloneAudit({
      kind: "report",
      mode: "print",
      payload: { secretFinding: "must stay private" },
      agentDir,
    })).toThrow("audit path contains a non-directory or symlink");
    expect(readdirSync(target)).toEqual([]);
  });
});
