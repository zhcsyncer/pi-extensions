import { describe, expect, it } from "vitest";
import { parseVerifyReport } from "../src/reports/parse-verify-report.ts";

describe("parseVerifyReport", () => {
  it("accepts one strict JSON object or one json fence", () => {
    expect(parseVerifyReport(JSON.stringify({
      refuted: true,
      reason: "The caller always wraps this path in a transaction.",
      evidence: ["src/save.ts:20 awaits transaction.commit"],
    }))).toEqual({
      refuted: true,
      reason: "The caller always wraps this path in a transaction.",
      evidence: ["src/save.ts:20 awaits transaction.commit"],
    });
    expect(parseVerifyReport(
      '```json\n{"refuted":false,"reason":"The race remains","evidence":[]}\n```',
    )).toMatchObject({ refuted: false, reason: "The race remains" });
  });

  it("keeps Markdown fence examples inside direct verifier strings as JSON data", () => {
    const output = JSON.stringify({
      refuted: true,
      reason: "The counterexample includes:\n```json\n{\"safe\":true}\n```",
      evidence: ["The implementation literally emits ```json after an escaped newline."],
    });

    const parsed = parseVerifyReport(output);
    expect(parsed.reason).toContain("```json");
    expect(parsed.evidence[0]).toContain("```json");
  });

  it("requires concrete evidence before accepting refuted=true", () => {
    expect(() => parseVerifyReport(
      '{"refuted":true,"reason":"looks safe","evidence":[]}',
    )).toThrow("requires concrete evidence");
  });

  it("rejects blank fields, extra schema fields, multiple objects, and commentary", () => {
    expect(() => parseVerifyReport(
      '{"refuted":false,"reason":"   ","evidence":[]}',
    )).toThrow("reason must not be blank");
    expect(() => parseVerifyReport(
      '{"refuted":false,"reason":"survives","evidence":[],"verdict":"approve"}',
    )).toThrow("schema mismatch");
    expect(() => parseVerifyReport(
      '{"refuted":false,"reason":"one","evidence":[]} {"refuted":false,"reason":"two","evidence":[]}',
    )).toThrow("multiple JSON objects");
    expect(() => parseVerifyReport(
      '{"refuted":false,"reason":"survives","evidence":[]} explanation',
    )).toThrow("trailing commentary");
    expect(() => parseVerifyReport(JSON.stringify({
      refuted: false,
      reason: "unsafe\u001b[2Jterminal control",
      evidence: [],
    }))).toThrow("reason must not contain control characters");
  });
});
