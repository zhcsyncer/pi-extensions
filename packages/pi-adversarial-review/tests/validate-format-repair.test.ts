import { describe, expect, it } from "vitest";
import { parseAndValidateFormatRepair } from "../src/reports/validate-format-repair.ts";

function report(overrides: Record<string, unknown> = {}) {
  return {
    verdict: "needs-attention",
    summary: "A material issue exists.",
    findings: [{
      file: "src/example.ts",
      lineStart: 4,
      lineEnd: 6,
      severity: "high",
      category: "correctness",
      confidence: 0.9,
      invariant: "Requests preserve user data",
      issue: "The failure path drops data.",
      evidence: "src/example.ts:4 clears state before persistence.",
      recommendation: "Persist before clearing state.",
    }],
    ...overrides,
  };
}

describe("parseAndValidateFormatRepair", () => {
  it("accepts framing-only repair of one complete embedded ReviewReport", () => {
    const payload = JSON.stringify(report({ verdict: "approve", findings: [] }));
    const malformed = `Analysis before the object.\n\n\`\`\`json\n\`\`\`\n\n${payload}`;

    expect(parseAndValidateFormatRepair(malformed, payload)).toEqual({
      verdict: "approve",
      summary: "A material issue exists.",
      findings: [],
    });
  });

  it("accepts removal of trailing commentary without changing findings", () => {
    const payload = JSON.stringify(report());
    expect(parseAndValidateFormatRepair(`${payload}\nDone.`, payload)).toEqual(report());
  });

  it("rejects invented or changed review semantics", () => {
    const payload = JSON.stringify(report());
    expect(() => parseAndValidateFormatRepair(
      payload,
      JSON.stringify(report({ summary: "Changed summary" })),
    )).toThrow("changed ReviewReport semantics");
    expect(() => parseAndValidateFormatRepair(
      "The workspace is unavailable.",
      JSON.stringify({ verdict: "approve", summary: "No issues", findings: [] }),
    )).toThrow("found 0");
  });

  it("rejects ambiguous source containing two complete reports", () => {
    const payload = JSON.stringify(report({ verdict: "approve", findings: [] }));
    expect(() => parseAndValidateFormatRepair(
      `${payload}\n${payload}`,
      payload,
    )).toThrow("found 2");
  });

  it("rejects a retry that is still not valid ReviewReport JSON", () => {
    const payload = JSON.stringify(report({ verdict: "approve", findings: [] }));
    expect(() => parseAndValidateFormatRepair(payload, "FORMAT_REPAIR_IMPOSSIBLE"))
      .toThrow("does not contain a JSON object");
  });
});
