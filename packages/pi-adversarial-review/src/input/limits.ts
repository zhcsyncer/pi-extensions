import { OversizedReviewInputError } from "./errors.ts";

export const MAX_FROZEN_INPUT_BYTES = 200 * 1024;
export const MAX_FROZEN_INPUT_LINES = 5_000;

export interface InputSize {
  bytes: number;
  lines: number;
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
): InputSize {
  const size = measureFrozenInput(content);
  if (size.bytes > maxBytes || size.lines > maxLines) {
    throw new OversizedReviewInputError(size.bytes, size.lines, maxBytes, maxLines);
  }
  return size;
}
