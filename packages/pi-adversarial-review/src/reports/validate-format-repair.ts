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
 * Accept a retry only when it is semantically identical to the one complete,
 * schema-valid ReviewReport already embedded in the original output. This makes
 * the model a formatter rather than a second reviewer.
 */
export function parseAndValidateFormatRepair(
  originalRawOutput: string,
  repairedRawOutput: string,
): ReviewReport {
  const repaired = parseReviewReport(repairedRawOutput);
  const sourceReports = reportsAlreadyPresent(originalRawOutput);
  if (sourceReports.length !== 1) {
    throw new InvalidReviewOutputError(
      `Format repair source must contain exactly one complete ReviewReport JSON object; found ${sourceReports.length}.`,
    );
  }
  if (JSON.stringify(repaired) !== JSON.stringify(sourceReports[0])) {
    throw new InvalidReviewOutputError(
      "Format repair changed ReviewReport semantics instead of only repairing framing.",
    );
  }
  return repaired;
}
