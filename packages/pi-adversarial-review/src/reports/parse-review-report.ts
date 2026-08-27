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

function unwrapSingleJsonFence(
  input: string,
  actor: string,
  allowPrefix: boolean,
): string {
  // A framing fence must be an actual Markdown opening line. Backticks inside
  // JSON string values (normally represented after an escaped `\\n`) are data.
  const opening = /(^|\r?\n)[\t ]*```([^\r\n]*)\r?\n/u.exec(input);
  if (!opening) return input;
  const openingIndex = opening.index + opening[1].length;
  if (openingIndex !== 0 && !allowPrefix) return input;
  if (opening[2].trim() !== "json") {
    throw new InvalidReviewOutputError(`${actor} output contains an unsupported Markdown fence.`);
  }

  const contentStart = opening.index + opening[0].length;
  const remainder = input.slice(contentStart);
  const closing = /\r?\n[\t ]*```[\t ]*(?=\r?\n|$)/u.exec(remainder);
  if (!closing) {
    throw new InvalidReviewOutputError(`${actor} output contains an unclosed JSON fence.`);
  }
  const afterClosing = remainder.slice(closing.index + closing[0].length);
  if (afterClosing.trim()) {
    throw new InvalidReviewOutputError(`${actor} output contains text after the closing JSON fence.`);
  }
  const prefix = input.slice(0, openingIndex);
  const fencedContent = remainder.slice(0, closing.index);
  return `${prefix}\n${fencedContent}`.trim();
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

export function parseJsonObject(
  rawOutput: string,
  actor = "Reviewer",
  options: { allowPrefixedJsonFence?: boolean } = {},
): unknown {
  const trimmed = rawOutput.trim();
  if (!trimmed) throw new InvalidReviewOutputError(`${actor} output is empty.`);
  try {
    return JSON.parse(trimmed);
  } catch {
    // Framing compatibility is only considered after the complete output has
    // failed direct parsing, so Markdown examples inside valid JSON stay data.
  }

  const candidate = unwrapSingleJsonFence(
    trimmed,
    actor,
    options.allowPrefixedJsonFence === true,
  );
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
  const value = parseJsonObject(rawOutput, "Reviewer", { allowPrefixedJsonFence: true });
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
