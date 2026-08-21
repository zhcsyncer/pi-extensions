import type { ReviewReport } from "../types.ts";
import {
  InvalidReviewOutputError,
  parseReviewReport,
} from "./parse-review-report.ts";

/**
 * Extract balanced top-level JSON object candidates without interpreting prose.
 * Objects inside JSON strings remain part of their enclosing candidate.
 */
function balancedObjectCandidates(input: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (start < 0) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        candidates.push(input.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

function reportsAlreadyPresent(source: string): ReviewReport[] {
  const reports: ReviewReport[] = [];
  for (const candidate of balancedObjectCandidates(source)) {
    try {
      reports.push(parseReviewReport(candidate));
    } catch {
      // Non-report JSON and incomplete/schema-invalid report-shaped objects do
      // not provide semantics a format-only retry may invent or repair.
    }
  }
  return reports;
}

/**
 * Prove before spending another model call that the invalid output is only a
 * framing candidate: exactly one complete, schema-valid report already exists.
 */
export function parseFormatRepairSource(originalRawOutput: string): ReviewReport {
  const sourceReports = reportsAlreadyPresent(originalRawOutput);
  if (sourceReports.length !== 1) {
    throw new InvalidReviewOutputError(
      `Format repair source must contain exactly one complete ReviewReport JSON object; found ${sourceReports.length}.`,
    );
  }
  return sourceReports[0]!;
}

/** Accept only a direct re-emission of the already-proven source report. */
export function parseAndValidateFormatRepairAgainstSource(
  sourceReport: ReviewReport,
  repairedRawOutput: string,
): ReviewReport {
  const repaired = parseReviewReport(repairedRawOutput);
  if (JSON.stringify(repaired) !== JSON.stringify(sourceReport)) {
    throw new InvalidReviewOutputError(
      "Format repair changed ReviewReport semantics instead of only repairing framing.",
    );
  }
  return repaired;
}

/**
 * Convenience contract for callers that do not need to retain the preflight
 * result. Runtime orchestration uses the two-stage API to avoid futile retries.
 */
export function parseAndValidateFormatRepair(
  originalRawOutput: string,
  repairedRawOutput: string,
): ReviewReport {
  return parseAndValidateFormatRepairAgainstSource(
    parseFormatRepairSource(originalRawOutput),
    repairedRawOutput,
  );
}
