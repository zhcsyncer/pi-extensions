import { ADVERSARIAL_REVIEW_RESULT_TYPE } from "./publish-report.ts";

export interface ReviewedTargetSpan {
  exclusiveLeft?: string;
  inclusiveRight: string;
}

export interface RangeStartIdentity {
  commitSha: string;
  parentSha: string;
}

const COMPLETED_OVERALL = new Set(["candidate-approve", "needs-adjudication"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isCompletedReviewOverall(overall: string): boolean {
  return COMPLETED_OVERALL.has(overall);
}

/** Commits included by a frozen target. Local-only reviews cover no commit range. */
export function reviewTargetSpan(target: {
  mode?: string;
  headSha?: string;
  baseSha?: string;
  fromSha?: string;
  toSha?: string;
}): ReviewedTargetSpan | undefined {
  if (target.mode === "local") return undefined;
  if (target.mode === "range") {
    if (typeof target.toSha !== "string" || target.toSha.length === 0) return undefined;
    return {
      inclusiveRight: target.toSha,
      ...(typeof target.fromSha === "string" && target.fromSha.length > 0
        ? { exclusiveLeft: target.fromSha }
        : {}),
    };
  }
  if (typeof target.headSha !== "string" || target.headSha.length === 0) return undefined;
  if (target.mode === "base" || target.baseSha) {
    return {
      inclusiveRight: target.headSha,
      ...(typeof target.baseSha === "string" && target.baseSha.length > 0
        ? { exclusiveLeft: target.baseSha }
        : {}),
    };
  }
  return undefined;
}

/**
 * Mark first-parent picker rows covered by prior completed reviews.
 * `starts` is newest-first. A span with no exclusive left marks only its endpoint.
 * Intermediate commits are marked only when the walk from the endpoint actually
 * reaches `exclusiveLeft` on this list; otherwise only the endpoint is marked.
 */
export function reviewedCommitShas(
  starts: readonly RangeStartIdentity[],
  spans: readonly ReviewedTargetSpan[],
): Set<string> {
  const reviewed = new Set<string>();
  for (const span of spans) {
    if (starts.some((start) => start.commitSha === span.inclusiveRight)) {
      reviewed.add(span.inclusiveRight);
    }
    if (!span.exclusiveLeft) continue;
    const covered: string[] = [];
    let covering = false;
    let reachedLeft = false;
    for (const start of starts) {
      if (start.commitSha === span.inclusiveRight) covering = true;
      if (!covering) continue;
      if (start.commitSha === span.exclusiveLeft) {
        reachedLeft = true;
        break;
      }
      covered.push(start.commitSha);
      if (start.parentSha === span.exclusiveLeft) {
        reachedLeft = true;
        break;
      }
    }
    if (!reachedLeft) continue;
    for (const sha of covered) reviewed.add(sha);
  }
  return reviewed;
}

function resultEntryData(entry: unknown): { overall: string; target: Record<string, unknown> } | undefined {
  if (!isRecord(entry)) return undefined;
  if (entry.customType !== ADVERSARIAL_REVIEW_RESULT_TYPE) return undefined;
  if (entry.type !== undefined && entry.type !== "custom") return undefined;
  if (!isRecord(entry.data) || typeof entry.data.overall !== "string") return undefined;
  if (!isRecord(entry.data.target)) return undefined;
  return { overall: entry.data.overall, target: entry.data.target };
}

/** Replay completed review spans from the current session branch. */
export function completedReviewSpansFromSessionEntries(
  entries: Iterable<unknown>,
): ReviewedTargetSpan[] {
  const spans: ReviewedTargetSpan[] = [];
  for (const entry of entries) {
    const data = resultEntryData(entry);
    if (!data || !isCompletedReviewOverall(data.overall)) continue;
    const span = reviewTargetSpan({
      mode: typeof data.target.mode === "string" ? data.target.mode : undefined,
      headSha: typeof data.target.headSha === "string" ? data.target.headSha : undefined,
      baseSha: typeof data.target.baseSha === "string" ? data.target.baseSha : undefined,
      fromSha: typeof data.target.fromSha === "string" ? data.target.fromSha : undefined,
      toSha: typeof data.target.toSha === "string" ? data.target.toSha : undefined,
    });
    if (span) spans.push(span);
  }
  return spans;
}

export function sessionBranchEntries(sessionManager: {
  getBranch?: () => Iterable<unknown>;
} | undefined): Iterable<unknown> {
  try {
    return sessionManager?.getBranch?.() ?? [];
  } catch {
    return [];
  }
}
