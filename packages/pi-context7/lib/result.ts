import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export function toToolResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function textContent(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  return (
    result.content
      ?.filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string)
      .join("\n") ?? ""
  );
}

export function measureText(text: string): { byteLength: number; lineCount: number } {
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (text.length === 0) {
    return { byteLength: 0, lineCount: 0 };
  }
  return {
    byteLength,
    lineCount: text.split(/\r?\n/).length,
  };
}

function formatBinaryUnit(value: number): string {
  // Keep one decimal place so values like 18842 bytes stay "18.4 KiB".
  return value.toFixed(1);
}

/** Format a byte length with binary units (KiB/MiB), not decimal KB/MB. */
export function formatByteSize(bytes: number): string {
  const safeBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safeBytes < 1024) return `${Math.round(safeBytes)} B`;

  const kib = safeBytes / 1024;
  if (kib < 1024) {
    return `${formatBinaryUnit(kib)} KiB`;
  }

  const mib = kib / 1024;
  return `${formatBinaryUnit(mib)} MiB`;
}
