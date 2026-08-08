import { Type } from "typebox";

export const FindingSchema = Type.Object({
  file: Type.String({ minLength: 1 }),
  lineStart: Type.Integer({ minimum: 1 }),
  lineEnd: Type.Integer({ minimum: 1 }),
  severity: Type.Union([
    Type.Literal("critical"),
    Type.Literal("high"),
    Type.Literal("medium"),
    Type.Literal("low"),
  ]),
  category: Type.Union([
    Type.Literal("auth"),
    Type.Literal("data-integrity"),
    Type.Literal("concurrency"),
    Type.Literal("failure-recovery"),
    Type.Literal("compatibility"),
    Type.Literal("observability"),
    Type.Literal("correctness"),
    Type.Literal("security"),
    Type.Literal("performance"),
    Type.Literal("other"),
  ]),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  invariant: Type.String({ minLength: 1 }),
  issue: Type.String({ minLength: 1 }),
  evidence: Type.String({ minLength: 1 }),
  recommendation: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const ReviewReportSchema = Type.Object({
  verdict: Type.Union([Type.Literal("needs-attention"), Type.Literal("approve")]),
  summary: Type.String({ minLength: 1 }),
  findings: Type.Array(FindingSchema),
}, { additionalProperties: false });
