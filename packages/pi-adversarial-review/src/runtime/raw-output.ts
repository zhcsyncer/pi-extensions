import { StringDecoder } from "node:string_decoder";

export const MAX_RAW_OUTPUT_BYTES = 64 * 1024;
export const RAW_OUTPUT_TRUNCATION_MARKER = "\n...[truncated]";

/** Return valid UTF-8 whose marker is included inside the 64 KiB audit cap. */
export function truncateRawOutput(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= MAX_RAW_OUTPUT_BYTES) return value;

  const markerBytes = Buffer.byteLength(RAW_OUTPUT_TRUNCATION_MARKER, "utf8");
  const budget = MAX_RAW_OUTPUT_BYTES - markerBytes;
  const decoder = new StringDecoder("utf8");
  const prefix = decoder.write(bytes.subarray(0, budget));
  return `${prefix}${RAW_OUTPUT_TRUNCATION_MARKER}`;
}
