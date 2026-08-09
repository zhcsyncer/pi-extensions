import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADVERSARIAL_REVIEW_ERROR_TYPE,
  emitHeadlessDiagnostic,
  publishReviewFailure,
} from "../src/output/headless-output.ts";

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
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
    });

    expect(appendEntry).toHaveBeenCalledWith(ADVERSARIAL_REVIEW_ERROR_TYPE, {
      version: 1,
      kind: "runtime",
      message: "provider failed�[2Jclear",
      mode: "print",
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    expect(error).toHaveBeenCalledWith("provider failed�[2Jclear");
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
    });

    expect(appendEntry).toHaveBeenCalledWith(
      ADVERSARIAL_REVIEW_ERROR_TYPE,
      expect.objectContaining({ kind: "command", message: "bad arguments", mode: "rpc" }),
    );
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(originalExitCode);
  });

  it("does not persist invisible error entries for ordinary TUI mistakes", () => {
    const appendEntry = vi.fn();

    publishReviewFailure({
      pi: { appendEntry } as unknown as ExtensionAPI,
      mode: "tui",
      kind: "command",
      message: "bad arguments",
    });

    expect(appendEntry).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(originalExitCode);
  });

  it("writes warnings to stderr without changing exit status or stdout framing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    emitHeadlessDiagnostic("json", "old runtime ignored\u001b]0;title\u0007");

    expect(error).toHaveBeenCalledWith("old runtime ignored�]0;title�");
    expect(process.exitCode).toBe(originalExitCode);
  });
});
