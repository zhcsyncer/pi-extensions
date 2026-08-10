import { describe, expect, it } from "vitest";
import { parseReviewCommand, ReviewCommandError } from "../src/command/parse-args.ts";

describe("parseReviewCommand", () => {
  it("parses repeated reviewers and quoted shared focus", () => {
    expect(parseReviewCommand(
      '--reviewer provider/a@high --reviewer provider/b@xhigh --focus "concurrency and retries" --gating strict',
    )).toEqual({
      target: { mode: "local" },
      targetExplicit: false,
      reviewerSpecs: ["provider/a@high", "provider/b@xhigh"],
      focus: "concurrency and retries",
      gating: "strict",
      allowLarge: false,
      refute: false,
    });
  });

  it("parses explicit local, base, and range targets", () => {
    expect(parseReviewCommand("--local")).toMatchObject({
      target: { mode: "local" },
      targetExplicit: true,
    });
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
      "--local, --base, and --range are mutually exclusive",
    );
    expect(() => parseReviewCommand("--local --base main")).toThrow(
      "--local, --base, and --range are mutually exclusive",
    );
    expect(() => parseReviewCommand("--range main...feature")).toThrow(
      '--range must use exactly "<refA>..<refB>"',
    );
  });

  it("parses one explicit large-target acknowledgement", () => {
    expect(parseReviewCommand("--allow-large")).toMatchObject({ allowLarge: true });
    expect(() => parseReviewCommand("--allow-large --allow-large")).toThrow(
      "--allow-large may be provided only once",
    );
  });

  it("parses refute with one explicit refuter", () => {
    expect(parseReviewCommand(
      "--refute --refuter provider/refuter@high --reviewer provider/a@off --reviewer provider/b@low",
    )).toMatchObject({
      refute: true,
      refuterSpec: "provider/refuter@high",
    });
  });

  it("requires --refute for refuter and rejects duplicate refute options", () => {
    expect(() => parseReviewCommand("--refuter provider/model@high")).toThrow(
      "--refuter requires --refute",
    );
    expect(() => parseReviewCommand("--refute --refute")).toThrow(
      "--refute may be provided only once",
    );
    expect(() => parseReviewCommand(
      "--refute --refuter provider/a@high --refuter provider/b@high",
    )).toThrow("--refuter may be provided only once");
  });

  it("rejects unknown input", () => {
    expect(() => parseReviewCommand("--mystery value")).toThrow("Unknown option: --mystery");
    expect(() => parseReviewCommand("positional")).toThrow("Unexpected argument: positional");
  });

  it("fails clearly on missing values and unclosed quotes", () => {
    expect(() => parseReviewCommand("--reviewer --gating strict")).toThrow("--reviewer requires a value");
    expect(() => parseReviewCommand('--focus "unfinished')).toThrow(ReviewCommandError);
  });
});
