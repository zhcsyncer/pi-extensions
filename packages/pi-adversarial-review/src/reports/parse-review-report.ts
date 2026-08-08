import path from "node:path";
import { Value } from "typebox/value";
import type { Finding, ReviewReport } from "../types.ts";
import { ReviewReportSchema } from "./schema.ts";

export class InvalidReviewOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReviewOutputError";
  }
}

function unwrapSingleJsonFence(input: string): string {
  const match = /^```json[\t ]*\r?\n([\s\S]*?)\r?\n```[\t ]*$/u.exec(input);
  return match ? match[1].trim() : input;
}

function balancedObjectCandidate(input: string, actor: string): string {
  const candidates: Array<{ start: number; end: number }> = [];
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
        candidates.push({ start, end: index + 1 });
        start = -1;
      }
    }
  }

  if (start >= 0 || inString) {
    throw new InvalidReviewOutputError(`${actor} output contains truncated JSON.`);
  }
  if (candidates.length !== 1) {
    throw new InvalidReviewOutputError(
      candidates.length === 0
        ? `${actor} output does not contain a JSON object.`
        : `${actor} output contains multiple JSON objects.`,
    );
  }
  const [candidate] = candidates;
  if (input.slice(candidate.end).trim()) {
    throw new InvalidReviewOutputError(`${actor} output contains trailing commentary after JSON.`);
  }
  return input.slice(candidate.start, candidate.end);
}

export function parseJsonObject(rawOutput: string, actor = "Reviewer"): unknown {
  const trimmed = rawOutput.trim();
  if (!trimmed) throw new InvalidReviewOutputError(`${actor} output is empty.`);
  const candidate = unwrapSingleJsonFence(trimmed);
  try {
    return JSON.parse(candidate);
  } catch {
    const balanced = balancedObjectCandidate(candidate, actor);
    try {
      return JSON.parse(balanced);
    } catch {
      throw new InvalidReviewOutputError(`${actor} output is not valid JSON.`);
    }
  }
}

export function requiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new InvalidReviewOutputError(`${field} must not be blank.`);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(trimmed)) {
    throw new InvalidReviewOutputError(`${field} must not contain control characters.`);
  }
  return trimmed;
}

function normalizedFile(value: string): string {
  if (
    !value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.includes("\\") ||
    value.split("/").includes("..")
  ) {
    throw new InvalidReviewOutputError("Finding file must be a relative POSIX path.");
  }
  const normalized = path.posix.normalize(value);
  if (
    path.posix.isAbsolute(normalized) ||
    !normalized.trim() ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new InvalidReviewOutputError("Finding file must stay inside the review repository.");
  }
  return normalized.replace(/^\.\//u, "");
}

function normalizeFinding(finding: Finding, index: number): Finding {
  if (finding.lineStart > finding.lineEnd) {
    throw new InvalidReviewOutputError(`findings[${index}] lineStart must not exceed lineEnd.`);
  }
  return {
    ...finding,
    file: normalizedFile(finding.file),
    invariant: requiredText(finding.invariant, `findings[${index}].invariant`),
    issue: requiredText(finding.issue, `findings[${index}].issue`),
    evidence: requiredText(finding.evidence, `findings[${index}].evidence`),
    recommendation: requiredText(finding.recommendation, `findings[${index}].recommendation`),
  };
}

export function parseReviewReport(rawOutput: string): ReviewReport {
  const value = parseJsonObject(rawOutput, "Reviewer");
  if (!Value.Check(ReviewReportSchema, value)) {
    const firstError = [...Value.Errors(ReviewReportSchema, value)][0];
    throw new InvalidReviewOutputError(
      firstError
        ? `Reviewer JSON schema mismatch at ${firstError.instancePath || "/"}.`
        : "Reviewer JSON schema mismatch.",
    );
  }

  const report = value as ReviewReport;
  if (report.verdict === "approve" && report.findings.length !== 0) {
    throw new InvalidReviewOutputError("An approve verdict must have no findings.");
  }
  if (report.verdict === "needs-attention" && report.findings.length === 0) {
    throw new InvalidReviewOutputError("A needs-attention verdict must include findings.");
  }
  return {
    verdict: report.verdict,
    summary: requiredText(report.summary, "summary"),
    findings: report.findings.map(normalizeFinding),
  };
}
