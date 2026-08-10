import { OversizedReviewInputError } from "./errors.ts";

// Above the recommended threshold, users must explicitly accept whole-target
// fan-out. The absolute limit still rejects pathological/generated input.
export const RECOMMENDED_FROZEN_INPUT_BYTES = 200 * 1024;
export const RECOMMENDED_FROZEN_INPUT_LINES = 5_000;
export const MAX_FROZEN_INPUT_BYTES = 1024 * 1024;
export const MAX_FROZEN_INPUT_LINES = 25_000;

export interface InputSize {
  bytes: number;
  lines: number;
}

export interface InputLimitContext {
  subject?: string;
  canSuggestRanges?: boolean;
}

export function measureFrozenInput(content: string): InputSize {
  const bytes = Buffer.byteLength(content, "utf8");
  const newlineCount = content.match(/\n/gu)?.length ?? 0;
  const lines = content.length === 0 ? 0 : newlineCount + (content.endsWith("\n") ? 0 : 1);
  return { bytes, lines };
}

export function assertFrozenInputWithinLimits(
  content: string,
  maxBytes = MAX_FROZEN_INPUT_BYTES,
  maxLines = MAX_FROZEN_INPUT_LINES,
  context: InputLimitContext = {},
): InputSize {
  const size = measureFrozenInput(content);
  const bytesExceeded = size.bytes > maxBytes;
  const linesExceeded = size.lines > maxLines;
  if (bytesExceeded || linesExceeded) {
    throw new OversizedReviewInputError({
      ...(bytesExceeded ? { bytes: { limit: maxBytes, actual: size.bytes } } : {}),
      ...(linesExceeded ? { lines: { limit: maxLines, actual: size.lines } } : {}),
      ...(context.subject ? { subject: context.subject } : {}),
      ...(context.canSuggestRanges !== undefined
        ? { canSuggestRanges: context.canSuggestRanges }
        : {}),
    });
  }
  return size;
}
