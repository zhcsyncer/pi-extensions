import { describe, expect, it } from "vitest";
import { InvalidReviewOutputError, parseReviewReport } from "../src/reports/parse-review-report.ts";

function report(overrides: Record<string, unknown> = {}) {
  return {
    verdict: "needs-attention",
    summary: "A material issue exists.",
    findings: [{
      file: "./src/example.ts",
      lineStart: 4,
      lineEnd: 6,
      severity: "high",
      category: "correctness",
      confidence: 0.9,
      invariant: "  requests preserve user data  ",
      issue: "The failure path drops data.",
      evidence: "src/example.ts:4 clears state before persistence.",
      recommendation: "Persist before clearing state.",
    }],
    ...overrides,
  };
}

describe("parseReviewReport", () => {
  it("accepts direct JSON, a single json fence, and one balanced object", () => {
    const direct = parseReviewReport(JSON.stringify(report()));
    expect(direct.findings[0].file).toBe("src/example.ts");
    expect(direct.findings[0].invariant).toBe("requests preserve user data");

    expect(parseReviewReport(`\`\`\`json\n${JSON.stringify(report({ verdict: "approve", findings: [] }))}\n\`\`\``))
      .toMatchObject({ verdict: "approve", findings: [] });

    const prefixed = `Result follows:\n${JSON.stringify(report({ summary: "Brace } inside string" }))}`;
    expect(parseReviewReport(prefixed).summary).toBe("Brace } inside string");
  });

  it("rejects multiple objects, trailing commentary, and truncated JSON", () => {
    expect(() => parseReviewReport(`${JSON.stringify(report())}\n{}`)).toThrow("multiple JSON objects");
    expect(() => parseReviewReport(`${JSON.stringify(report())}\nDone`)).toThrow("trailing commentary");
    expect(() => parseReviewReport('{"verdict":"approve"')).toThrow("truncated JSON");
  });

  it("rejects schema drift and model-supplied route identity", () => {
    expect(() => parseReviewReport(JSON.stringify({ ...report(), reviewer: "fake-route" })))
      .toThrow("schema mismatch");
    expect(() => parseReviewReport(JSON.stringify(report({ confidence: 2 }))))
      .toThrow(InvalidReviewOutputError);
  });

  it("enforces repository-relative POSIX paths and line ranges", () => {
    for (const file of [
      "/etc/passwd",
      "../outside.ts",
      "src/../outside.ts",
      "src\\windows.ts",
      "   ",
      "./   ",
      "src/control\nname.ts",
    ]) {
      const invalid = report();
      (invalid.findings as Array<Record<string, unknown>>)[0].file = file;
      expect(() => parseReviewReport(JSON.stringify(invalid))).toThrow(/path|repository/u);
    }

    const reversed = report();
    (reversed.findings as Array<Record<string, unknown>>)[0].lineStart = 9;
    (reversed.findings as Array<Record<string, unknown>>)[0].lineEnd = 2;
    expect(() => parseReviewReport(JSON.stringify(reversed))).toThrow("lineStart must not exceed lineEnd");
  });

  it("enforces verdict/findings coupling and material evidence", () => {
    expect(() => parseReviewReport(JSON.stringify(report({ verdict: "approve" }))))
      .toThrow("approve verdict must have no findings");
    expect(() => parseReviewReport(JSON.stringify(report({ findings: [] }))))
      .toThrow("needs-attention verdict must include findings");

    const blankEvidence = report();
    (blankEvidence.findings as Array<Record<string, unknown>>)[0].evidence = "   ";
    expect(() => parseReviewReport(JSON.stringify(blankEvidence))).toThrow("evidence must not be blank");

    const terminalEscape = report();
    (terminalEscape.findings as Array<Record<string, unknown>>)[0].issue = "unsafe\u001b[31mred";
    expect(() => parseReviewReport(JSON.stringify(terminalEscape))).toThrow(
      "issue must not contain control characters",
    );
  });
});
