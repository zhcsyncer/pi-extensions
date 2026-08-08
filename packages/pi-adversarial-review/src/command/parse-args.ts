import type { GatingMode, ParsedReviewCommand, ReviewTargetRequest } from "../types.ts";

export class ReviewCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewCommandError";
  }
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (escaped) throw new ReviewCommandError("Command ends with an incomplete escape sequence.");
  if (quote) throw new ReviewCommandError("Command contains an unclosed quote.");
  if (started) tokens.push(current);
  return tokens;
}

function requireValue(tokens: string[], index: number, option: string): string {
  const value = tokens[index + 1];
  if (value === undefined || value.startsWith("--") || !value.trim()) {
    throw new ReviewCommandError(`${option} requires a value.`);
  }
  return value;
}

function parseRange(value: string): Extract<ReviewTargetRequest, { mode: "range" }> {
  const separator = value.indexOf("..");
  if (separator <= 0 || separator !== value.lastIndexOf("..")) {
    throw new ReviewCommandError('--range must use exactly "<refA>..<refB>".');
  }
  const fromRef = value.slice(0, separator);
  const toRef = value.slice(separator + 2);
  if (!fromRef || !toRef) {
    throw new ReviewCommandError('--range must use exactly "<refA>..<refB>".');
  }
  return { mode: "range", fromRef, toRef };
}

export function parseReviewCommand(input: string): ParsedReviewCommand {
  const tokens = tokenize(input);
  const reviewerSpecs: string[] = [];
  let baseRef: string | undefined;
  let range: Extract<ReviewTargetRequest, { mode: "range" }> | undefined;
  let reqdoc: string | undefined;
  let focus: string | undefined;
  let gating: GatingMode = "weighted";

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    switch (token) {
      case "--base":
        if (baseRef !== undefined) throw new ReviewCommandError("--base may be provided only once.");
        baseRef = requireValue(tokens, index, token);
        index++;
        break;
      case "--range":
        if (range !== undefined) throw new ReviewCommandError("--range may be provided only once.");
        range = parseRange(requireValue(tokens, index, token));
        index++;
        break;
      case "--reqdoc":
        if (reqdoc !== undefined) throw new ReviewCommandError("--reqdoc may be provided only once.");
        reqdoc = requireValue(tokens, index, token);
        index++;
        break;
      case "--focus":
        if (focus !== undefined) throw new ReviewCommandError("--focus may be provided only once.");
        focus = requireValue(tokens, index, token);
        index++;
        break;
      case "--gating": {
        const value = requireValue(tokens, index, token);
        if (value !== "weighted" && value !== "strict") {
          throw new ReviewCommandError('--gating must be "weighted" or "strict".');
        }
        gating = value;
        index++;
        break;
      }
      case "--reviewer":
        reviewerSpecs.push(requireValue(tokens, index, token));
        index++;
        break;
      case "--refute":
      case "--refuter":
        throw new ReviewCommandError(`${token} is not available in the no-UI core phase.`);
      default:
        throw new ReviewCommandError(
          token.startsWith("--") ? `Unknown option: ${token}` : `Unexpected argument: ${token}`,
        );
    }
  }

  if (baseRef !== undefined && range !== undefined) {
    throw new ReviewCommandError("--base and --range are mutually exclusive.");
  }

  const target: ReviewTargetRequest = range ?? (baseRef ? { mode: "base", baseRef } : { mode: "local" });
  return {
    target,
    reviewerSpecs,
    gating,
    ...(reqdoc !== undefined ? { reqdoc } : {}),
    ...(focus !== undefined ? { focus } : {}),
  };
}
