import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { persistStandaloneAudit } from "./audit-store.ts";

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
  sessionId?: string;
  cwd?: string;
  now?: Date;
  agentDir?: string;
}): void {
  const message = safeReviewDiagnosticText(options.message);
  const occurredAt = options.now ?? new Date();
  let auditError: string | undefined;
  if (options.mode !== "tui") {
    const details = {
      version: 1,
      kind: options.kind,
      message,
      mode: options.mode,
      occurredAt: occurredAt.toISOString(),
    };
    try {
      persistStandaloneAudit({
        kind: "error",
        mode: options.mode,
        payload: details,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        now: occurredAt,
        ...(options.agentDir ? { agentDir: options.agentDir } : {}),
      });
    } catch (error) {
      auditError = safeReviewDiagnosticText(
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      options.pi.appendEntry(ADVERSARIAL_REVIEW_ERROR_TYPE, details);
    } catch {
      // The original failure remains authoritative even if the live entry fails.
    }
  }

  if (options.mode === "print" || options.mode === "json") {
    console.error(message);
    if (auditError) console.error(`Adversarial review audit persistence failed: ${auditError}`);
    if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1;
  }
}
