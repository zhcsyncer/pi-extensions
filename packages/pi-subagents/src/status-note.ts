/**
 * status-note.ts — Parenthetical status note appended to agent result text.
 */

/** Previous output is history, never this failed continuation's result. */
export function previousResultSuffix(record: { status: string; previousResult?: string }): string {
  if (!["error", "aborted", "stopped"].includes(record.status) || !record.previousResult?.trim()) return "";
  return `\n\n--- Previous report (before this continuation; NOT the current run's result) ---\n${record.previousResult}`;
}

/**
 * Explicit parenthetical note for a non-normal terminal outcome, so the parent
 * agent can't mistake partial output for a completed result. Empty string for a
 * clean completion (and any unknown/non-terminal status).
 *
 * `stopped` records an external stop. `aborted` can also come from internal
 * cancellation, so status alone does not identify a turn-limit cutoff.
 */
export function getStatusNote(status: string): string {
  switch (status) {
    case "stopped":
      return " (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)";
    case "aborted":
      return " (aborted before completion — output may be incomplete)";
    case "steered":
      return " (wrapped up at the turn limit — output may be partial)";
    default:
      return "";
  }
}
