import { Value } from "typebox/value";
import type { VerifyReport } from "../types.ts";
import {
  InvalidReviewOutputError,
  parseJsonObject,
  requiredText,
} from "./parse-review-report.ts";
import { VerifyReportSchema } from "./schema.ts";

export function parseVerifyReport(rawOutput: string): VerifyReport {
  const value = parseJsonObject(rawOutput, "Refuter");
  if (!Value.Check(VerifyReportSchema, value)) {
    const firstError = [...Value.Errors(VerifyReportSchema, value)][0];
    throw new InvalidReviewOutputError(
      firstError
        ? `Refuter JSON schema mismatch at ${firstError.instancePath || "/"}.`
        : "Refuter JSON schema mismatch.",
    );
  }

  const report = value as VerifyReport;
  const evidence = report.evidence.map((item, index) => (
    requiredText(item, `evidence[${index}]`)
  ));
  if (report.refuted && evidence.length === 0) {
    throw new InvalidReviewOutputError(
      "A refuted=true result requires concrete evidence.",
    );
  }
  return {
    refuted: report.refuted,
    reason: requiredText(report.reason, "reason"),
    evidence,
  };
}
