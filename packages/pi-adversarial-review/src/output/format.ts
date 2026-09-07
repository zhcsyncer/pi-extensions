import { keyHint } from "@earendil-works/pi-coding-agent";
import { safeReviewDiagnosticText } from "./headless-output.ts";

export function oneLine(value: string): string {
  return safeReviewDiagnosticText(value).replace(/\s+/gu, " ").trim();
}

/** Shorten frozen-target Git identities for TUI; full SHAs stay in audit payloads. */
export function shortSha(sha: string): string | undefined {
  const trimmed = sha.trim();
  if (!/^[0-9a-f]{7,64}$/iu.test(trimmed)) return undefined;
  return trimmed.slice(0, 7).toLowerCase();
}

export function headMarker(sha: string | undefined): string {
  const short = sha ? shortSha(sha) : undefined;
  return short ? ` · HEAD ${short}` : "";
}

export function compactTarget(description: string): string {
  return oneLine(description)
    .replace(/\b([0-9a-f]{7})[0-9a-f]{33,57}\b/gu, "$1")
    .replace(/\b([0-9a-f]{7}) \(\1\)/gu, "$1");
}

export function compactTargetSummary(summary: string): string {
  return oneLine(summary)
    .replace(/^Adversarial review target:\s*/u, "")
    .replace(/\.$/u, "");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function formatDurationMs(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return undefined;
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m${String(remainder).padStart(2, "0")}s` : `${seconds}s`;
}

export function formatUsageTotal(total: number | undefined): string | undefined {
  if (total === undefined || !Number.isFinite(total)) return undefined;
  if (total < 1000) return `${Math.max(0, Math.round(total))} tokens`;
  return `${(Math.max(0, total) / 1000).toFixed(1)}k tokens`;
}

export function expandHint(): string {
  try {
    const hint = keyHint("app.tools.expand", "details");
    return hint.trim() || "Ctrl+O details";
  } catch {
    return "Ctrl+O details";
  }
}

export function compactLine(value: string, maxLength = 180): string {
  const safe = oneLine(value);
  return safe.length <= maxLength ? safe : `${safe.slice(0, maxLength - 1)}…`;
}
