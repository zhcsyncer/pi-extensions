import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ADVERSARIAL_REVIEW_ERROR_TYPE = "adversarial-review-error";

export type ReviewFailureKind = "command" | "input" | "empty-input" | "runtime";

export function safeReviewDiagnosticText(value: string): string {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu, "�");
}

export function emitHeadlessDiagnostic(
  mode: "tui" | "rpc" | "json" | "print",
  message: string,
): void {
  if (mode === "print" || mode === "json") {
    console.error(safeReviewDiagnosticText(message));
  }
}

export function publishReviewFailure(options: {
  pi: ExtensionAPI;
  mode: "tui" | "rpc" | "json" | "print";
  kind: ReviewFailureKind;
  message: string;
  now?: Date;
}): void {
  const message = safeReviewDiagnosticText(options.message);
  if (options.mode !== "tui") {
    try {
      options.pi.appendEntry(ADVERSARIAL_REVIEW_ERROR_TYPE, {
        version: 1,
        kind: options.kind,
        message,
        mode: options.mode,
        occurredAt: (options.now ?? new Date()).toISOString(),
      });
    } catch {
      // The original failure remains authoritative even if audit persistence fails.
    }
  }

  if (options.mode === "print" || options.mode === "json") {
    console.error(message);
    if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1;
  }
}
