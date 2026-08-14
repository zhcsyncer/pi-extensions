import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADVERSARIAL_REVIEW_ERROR_TYPE,
  emitHeadlessDiagnostic,
  publishReviewFailure,
  renderReviewFailureEntry,
} from "../src/output/headless-output.ts";

const originalExitCode = process.exitCode;
let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-review-headless-audit-"));
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  rmSync(agentDir, { recursive: true, force: true });
});

describe("headless review output", () => {
  it("persists failures, writes safe stderr, and marks print/json runs failed", () => {
    const appendEntry = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    publishReviewFailure({
      pi: { appendEntry } as unknown as ExtensionAPI,
      mode: "print",
      kind: "runtime",
      message: "provider failed\u001b[2Jclear",
      now: new Date("2026-01-01T00:00:00.000Z"),
      agentDir,
    });

    expect(appendEntry).toHaveBeenCalledWith(ADVERSARIAL_REVIEW_ERROR_TYPE, {
      version: 1,
      kind: "runtime",
      message: "provider failed�[2Jclear",
      mode: "print",
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    expect(error).toHaveBeenCalledWith("provider failed�[2Jclear");
    const auditDir = join(agentDir, "extension-data", "pi-adversarial-review", "audit");
    const [auditFile] = readdirSync(auditDir);
    expect(auditFile).toBeDefined();
    expect(JSON.parse(readFileSync(join(auditDir, auditFile!), "utf8"))).toMatchObject({
      kind: "error",
      mode: "print",
      payload: { kind: "runtime", message: "provider failed�[2Jclear" },
    });
    expect(process.exitCode).toBe(1);
  });

  it("keeps RPC alive while retaining a machine-readable error entry", () => {
    const appendEntry = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    publishReviewFailure({
      pi: { appendEntry } as unknown as ExtensionAPI,
      mode: "rpc",
      kind: "command",
      message: "bad arguments",
      agentDir,
    });

    expect(appendEntry).toHaveBeenCalledWith(
      ADVERSARIAL_REVIEW_ERROR_TYPE,
      expect.objectContaining({ kind: "command", message: "bad arguments", mode: "rpc" }),
    );
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(originalExitCode);
  });

  it("persists visible error entries for ordinary TUI failures without changing exit status", () => {
    const appendEntry = vi.fn();

    publishReviewFailure({
      pi: { appendEntry } as unknown as ExtensionAPI,
      mode: "tui",
      kind: "command",
      message: "bad arguments",
    });

    expect(appendEntry).toHaveBeenCalledWith(
      ADVERSARIAL_REVIEW_ERROR_TYPE,
      expect.objectContaining({ kind: "command", message: "bad arguments", mode: "tui" }),
    );
    expect(process.exitCode).toBe(originalExitCode);
  });

  it("renders a durable TUI failure with run and target details", () => {
    const details = {
      version: 1 as const,
      kind: "runtime" as const,
      message: "Adversarial review failed: provider unavailable",
      mode: "tui" as const,
      occurredAt: "2026-01-01T00:00:00.000Z",
      runId: "run-123",
      target: "base origin/main ... HEAD",
    };
    const theme = { fg: (_color: string, text: string) => text } as any;
    const collapsed = renderReviewFailureEntry(details, { expanded: false }, theme)
      .render(120).join("\n");
    const expanded = renderReviewFailureEntry(details, { expanded: true }, theme)
      .render(120).join("\n");

    expect(collapsed).toContain("provider unavailable");
    expect(expanded).toContain("Target · base origin/main ... HEAD");
    expect(expanded).toContain("Run · run-123");
    expect(expanded).toContain("Failure · runtime");
  });

  it("writes warnings to stderr without changing exit status or stdout framing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    emitHeadlessDiagnostic("json", "old runtime ignored\u001b]0;title\u0007");

    expect(error).toHaveBeenCalledWith("old runtime ignored�]0;title�");
    expect(process.exitCode).toBe(originalExitCode);
  });
});
