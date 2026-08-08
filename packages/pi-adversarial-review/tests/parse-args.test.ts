import { describe, expect, it } from "vitest";
import { parseReviewCommand, ReviewCommandError } from "../src/command/parse-args.ts";

describe("parseReviewCommand", () => {
  it("parses repeated reviewers and quoted shared focus", () => {
    expect(parseReviewCommand(
      '--reviewer provider/a@high --reviewer provider/b@xhigh --focus "concurrency and retries" --gating strict',
    )).toEqual({
      target: { mode: "local" },
      reviewerSpecs: ["provider/a@high", "provider/b@xhigh"],
      focus: "concurrency and retries",
      gating: "strict",
    });
  });

  it("parses base and range targets", () => {
    expect(parseReviewCommand("--base origin/main").target).toEqual({
      mode: "base",
      baseRef: "origin/main",
    });
    expect(parseReviewCommand("--range main..feature").target).toEqual({
      mode: "range",
      fromRef: "main",
      toRef: "feature",
    });
  });

  it("rejects mutually exclusive and malformed targets", () => {
    expect(() => parseReviewCommand("--base main --range main..feature")).toThrow(
      "--base and --range are mutually exclusive",
    );
    expect(() => parseReviewCommand("--range main...feature")).toThrow(
      '--range must use exactly "<refA>..<refB>"',
    );
  });

  it("rejects unsupported phase options and unknown input", () => {
    expect(() => parseReviewCommand("--refute")).toThrow("not available in the no-UI core phase");
    expect(() => parseReviewCommand("--mystery value")).toThrow("Unknown option: --mystery");
    expect(() => parseReviewCommand("positional")).toThrow("Unexpected argument: positional");
  });

  it("fails clearly on missing values and unclosed quotes", () => {
    expect(() => parseReviewCommand("--reviewer --gating strict")).toThrow("--reviewer requires a value");
    expect(() => parseReviewCommand('--focus "unfinished')).toThrow(ReviewCommandError);
  });
});
