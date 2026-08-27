import { describe, expect, it } from "vitest";
import {
  MAX_RAW_OUTPUT_BYTES,
  RAW_OUTPUT_TRUNCATION_MARKER,
  truncateRawOutput,
} from "../src/runtime/raw-output.ts";

describe("truncateRawOutput", () => {
  it("keeps exact-limit output and includes the marker inside the cap", () => {
    const exact = "x".repeat(MAX_RAW_OUTPUT_BYTES);
    expect(truncateRawOutput(exact)).toBe(exact);

    const truncated = truncateRawOutput(`${exact}x`);
    expect(Buffer.byteLength(truncated, "utf8")).toBe(MAX_RAW_OUTPUT_BYTES);
    expect(truncated.endsWith(RAW_OUTPUT_TRUNCATION_MARKER)).toBe(true);
  });

  it("never splits a multi-byte UTF-8 code point", () => {
    const prefix = "x".repeat(MAX_RAW_OUTPUT_BYTES - 16);
    const truncated = truncateRawOutput(`${prefix}你你你你你你`);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(MAX_RAW_OUTPUT_BYTES);
    expect(truncated).not.toContain("�");
    expect(truncated.endsWith(RAW_OUTPUT_TRUNCATION_MARKER)).toBe(true);
  });
});
