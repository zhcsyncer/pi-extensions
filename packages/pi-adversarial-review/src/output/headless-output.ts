import type {
  EntryRenderOptions,
  ExtensionAPI,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { persistStandaloneAudit } from "./audit-store.ts";

export const ADVERSARIAL_REVIEW_ERROR_TYPE = "adversarial-review-error";

export type ReviewFailureKind = "command" | "input" | "empty-input" | "runtime";

export interface ReviewFailureEntry {
  version: 1;
  kind: ReviewFailureKind;
  message: string;
  mode: "tui" | "rpc" | "json" | "print";
  occurredAt: string;
  runId?: string;
  target?: string;
}

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

function isReviewFailureEntry(value: unknown): value is ReviewFailureEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 &&
    typeof candidate.kind === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.occurredAt === "string";
}

export function renderReviewFailureEntry(
  data: unknown,
  options: EntryRenderOptions,
  theme: Theme,
): Component {
  if (!isReviewFailureEntry(data)) {
    return new Text(theme.fg("error", "Adversarial review failure (invalid data)"), 1, 0);
  }
  const lines = [theme.fg("error", `× ${safeReviewDiagnosticText(data.message)}`)];
  if (options.expanded) {
    if (data.target) lines.push(`  ${theme.fg("muted", "Target")} · ${safeReviewDiagnosticText(data.target)}`);
    if (data.runId) lines.push(`  ${theme.fg("muted", "Run")} · ${safeReviewDiagnosticText(data.runId)}`);
    lines.push(`  ${theme.fg("muted", "Failure")} · ${data.kind} · ${data.occurredAt}`);
  }
  return new Text(lines.join("\n"), 1, 0);
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
  runId?: string;
  target?: string;
}): void {
  const message = safeReviewDiagnosticText(options.message);
  const occurredAt = options.now ?? new Date();
  const details: ReviewFailureEntry = {
    version: 1,
    kind: options.kind,
    message,
    mode: options.mode,
    occurredAt: occurredAt.toISOString(),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.target ? { target: safeReviewDiagnosticText(options.target) } : {}),
  };
  let auditError: string | undefined;
  if (options.mode !== "tui") {
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
  }
  try {
    options.pi.appendEntry(ADVERSARIAL_REVIEW_ERROR_TYPE, details);
  } catch {
    // The original failure remains authoritative even if the transcript is unavailable.
  }

  if (options.mode === "print" || options.mode === "json") {
    console.error(message);
    if (auditError) console.error(`Adversarial review audit persistence failed: ${auditError}`);
    if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1;
  }
}
