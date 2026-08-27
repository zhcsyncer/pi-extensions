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

  it("keeps Markdown examples inside two real direct reviewer output styles as JSON data", () => {
    const prettyRouteOutput = JSON.stringify(report({
      summary: "Pretty Ollama route output",
      findings: [{
        ...(report().findings as Array<Record<string, unknown>>)[0],
        evidence: "The route quoted source after an escaped newline:\n```ts\nconst prefix = input.slice(0);\n```",
      }],
    }), null, 2);
    const compactRouteOutput = JSON.stringify(report({
      summary: "Compact route mentions a ````json`` fence",
      findings: [{
        ...(report().findings as Array<Record<string, unknown>>)[0],
        issue: "A string demonstrates Intro text\\n```json\\n{…}\\n``` without framing the report.",
        evidence: "The current output contains literal ```${prefix}``` text.",
      }],
    }));

    expect(parseReviewReport(prettyRouteOutput).findings[0].evidence).toContain("```ts");
    expect(parseReviewReport(compactRouteOutput).summary).toContain("````json``");
  });

  it("accepts a prefixed bare object whose JSON strings contain fence text", () => {
    const payload = JSON.stringify(report({
      summary: "Embedded example:\n```json\n{\"example\":true}\n```",
    }));
    expect(parseReviewReport(`Result follows:\n${payload}`).summary).toContain("```json");
  });

  it("accepts one prefixed json fence that closes at the end", () => {
    const payload = JSON.stringify(report({
      verdict: "approve",
      summary: "Qwen framed result",
      findings: [],
    }));
    expect(parseReviewReport(`I will return the requested object.\n\n\`\`\`json\n${payload}\n\`\`\``))
      .toEqual({ verdict: "approve", summary: "Qwen framed result", findings: [] });
  });

  it("rejects multiple objects, trailing commentary, and truncated JSON", () => {
    expect(() => parseReviewReport(`${JSON.stringify(report())}\n{}`)).toThrow("multiple JSON objects");
    expect(() => parseReviewReport(`${JSON.stringify(report())}\nDone`)).toThrow("trailing commentary");
    expect(() => parseReviewReport('{"verdict":"approve"')).toThrow("truncated JSON");
  });

  it("keeps prefixed-fence compatibility narrow and schema-checked", () => {
    const valid = JSON.stringify(report({ verdict: "approve", findings: [] }));
    expect(() => parseReviewReport(
      `{\"preface\":true}\n\`\`\`json\n${valid}\n\`\`\``,
    )).toThrow("multiple JSON objects");
    expect(() => parseReviewReport(
      `Preface\n\`\`\`json\n${valid}\n{}\n\`\`\``,
    )).toThrow("multiple JSON objects");
    expect(() => parseReviewReport(
      'Preface\n```json\n{"verdict":"approve"\n```',
    )).toThrow("truncated JSON");
    expect(() => parseReviewReport(
      `Preface\n\`\`\`javascript\n${valid}\n\`\`\``,
    )).toThrow("unsupported Markdown fence");
    expect(() => parseReviewReport(
      `Preface\n\`\`\`json\n${valid}\n\`\`\`\nDone`,
    )).toThrow("text after the closing JSON fence");

    const qwenWithoutSummary = JSON.stringify({ verdict: "approve", findings: [] });
    expect(() => parseReviewReport(
      `Here is the result.\n\`\`\`json\n${qwenWithoutSummary}\n\`\`\``,
    )).toThrow("Reviewer JSON schema mismatch");
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
