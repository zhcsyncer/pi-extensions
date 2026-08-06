/**
 * conversation-brief.ts — Pure messages → brief progress view-model for ConversationViewer.
 *
 * Default overlay layout (scheme A):
 *   Prompt (dispatch) · Steps (one-line tool summaries) · Result (final assistant text)
 */

import { extractText } from "../context.js";

/** Max lines of the dispatch prompt shown before truncation note. */
export const PROMPT_MAX_LINES = 30;
/** Max characters for a single-line tool-result side note. */
export const RESULT_PREVIEW_MAX_CHARS = 80;
/** Max characters when collapsing arbitrary JSON/string args. */
export const ARGS_FALLBACK_MAX_CHARS = 120;

export type StepStatus = "running" | "completed" | "error";

export interface BriefStep {
  /** Tool-call id when known; synthetic ids for bashExecution / unmatched results. */
  id: string;
  toolName: string;
  /** One-line argument summary (no status icon). */
  summary: string;
  status: StepStatus;
  /** Short folded result note, e.g. "ok · 12 lines" or first-line preview. */
  resultNote?: string;
  isError: boolean;
  /** Full args text for optional expand mode. */
  argsText?: string;
  /** Full tool-result text for optional expand mode. */
  resultText?: string;
}

export interface ConversationBrief {
  /** First meaningful user message text (untruncated). */
  prompt: string | undefined;
  /** Later user messages (e.g. steers), in order. */
  steers: string[];
  steps: BriefStep[];
  /** Last non-empty assistant text content. */
  result: string | undefined;
}

export type LooseMessage = {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolUseId?: string;
  toolName?: string;
  isError?: boolean;
  command?: string;
  output?: string;
  [key: string]: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function firstString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function compactInline(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) return oneLine;
  if (maxChars <= 1) return "…";
  return `${oneLine.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Extract tool-call arguments from either `arguments` (pi-ai) or legacy `input`. */
export function getToolCallArgs(block: Record<string, unknown>): Record<string, unknown> {
  return asRecord(block.arguments) ?? asRecord(block.input) ?? asRecord(block.args) ?? {};
}

/** Extract tool-call id from `id` / `toolCallId` / `toolUseId`. */
export function getToolCallId(block: Record<string, unknown>): string | undefined {
  for (const key of ["id", "toolCallId", "toolUseId"] as const) {
    const v = block[key];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/** Human-readable one-line summary of tool arguments. */
export function summarizeToolArgs(toolName: string, args: Record<string, unknown>, maxChars = ARGS_FALLBACK_MAX_CHARS): string {
  const name = toolName.toLowerCase();
  const path = firstString(args, ["path", "file_path", "filePath", "filename", "file", "target"]);
  const command = firstString(args, ["command", "cmd"]);
  const pattern = firstString(args, ["pattern", "query", "regex", "search"]);
  const glob = firstString(args, ["glob", "include", "glob_pattern", "globPattern"]);
  const url = firstString(args, ["url", "uri", "href"]);

  let detail: string | undefined;

  if (command && (name === "bash" || name.includes("bash") || name === "shell")) {
    detail = command;
  } else if (path && (name === "read" || name === "write" || name === "edit" || name.includes("read") || name.includes("write") || name.includes("edit"))) {
    detail = path;
  } else if (pattern && (name === "grep" || name === "rg" || name.includes("grep") || name.includes("search"))) {
    const bits = [`${JSON.stringify(pattern)}`];
    if (path) bits.push(path);
    else if (glob) bits.push(glob);
    detail = bits.join(" ");
  } else if (pattern && path) {
    detail = `${JSON.stringify(pattern)} ${path}`;
  } else if (path) {
    detail = path;
  } else if (command) {
    detail = command;
  } else if (url) {
    detail = url;
  } else if (pattern) {
    detail = JSON.stringify(pattern);
  } else if (glob) {
    detail = glob;
  } else {
    const keys = Object.keys(args);
    if (keys.length === 0) {
      detail = undefined;
    } else {
      try {
        detail = JSON.stringify(args);
      } catch {
        detail = String(args);
      }
    }
  }

  if (!detail) return "";
  return compactInline(detail, maxChars);
}

/** Build a folded one-line note for a tool result body. */
export function summarizeToolResult(text: string, isError: boolean, maxChars = RESULT_PREVIEW_MAX_CHARS): string {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return isError ? "error" : "ok";

  const lines = trimmed.split("\n");
  const lineCount = lines.length;
  const first = compactInline(lines[0] ?? "", maxChars);

  if (isError) {
    return first ? `error · ${first}` : "error";
  }

  if (lineCount <= 1) {
    return first ? `ok · ${first}` : "ok";
  }
  // Prefer compact stats; include a short first-line peek when it still fits.
  const stats = `ok · ${lineCount} lines`;
  if (!first || first.length > Math.max(12, maxChars - stats.length - 3)) {
    return stats;
  }
  return `${stats} · ${first}`;
}

function messageText(msg: LooseMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) return extractText(msg.content);
  return "";
}

/**
 * Build the scheme-A brief view model from a session message list.
 * Pure: no theme, no TUI, no I/O.
 */
export function buildConversationBrief(messages: readonly LooseMessage[]): ConversationBrief {
  let prompt: string | undefined;
  const steers: string[] = [];
  const steps: BriefStep[] = [];
  const byId = new Map<string, BriefStep>();
  let result: string | undefined;
  let syntheticSeq = 0;

  const pushStep = (step: BriefStep): BriefStep => {
    steps.push(step);
    if (step.id) byId.set(step.id, step);
    return step;
  };

  for (const msg of messages) {
    const role = msg.role;
    if (role === "user") {
      const text = messageText(msg).trim();
      if (!text) continue;
      if (prompt === undefined) prompt = text;
      else steers.push(text);
      continue;
    }

    if (role === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const textParts: string[] = [];
      for (const raw of content) {
        const block = asRecord(raw);
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          textParts.push(block.text);
        } else if (block.type === "toolCall") {
          const toolName =
            (typeof block.name === "string" && block.name) ||
            (typeof block.toolName === "string" && block.toolName) ||
            "unknown";
          const id = getToolCallId(block) ?? `anon-${++syntheticSeq}`;
          const args = getToolCallArgs(block);
          let argsText: string | undefined;
          try {
            argsText = Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : undefined;
          } catch {
            argsText = undefined;
          }
          const existing = byId.get(id);
          if (existing) {
            existing.toolName = toolName;
            existing.summary = summarizeToolArgs(toolName, args);
            existing.argsText = argsText;
          } else {
            pushStep({
              id,
              toolName,
              summary: summarizeToolArgs(toolName, args),
              status: "running",
              isError: false,
              argsText,
            });
          }
        }
      }
      const joined = textParts.join("\n").trim();
      if (joined) result = joined;
      continue;
    }

    if (role === "toolResult") {
      const id =
        (typeof msg.toolCallId === "string" && msg.toolCallId) ||
        (typeof msg.toolUseId === "string" && msg.toolUseId) ||
        `result-${++syntheticSeq}`;
      const toolName =
        (typeof msg.toolName === "string" && msg.toolName) ||
        byId.get(id)?.toolName ||
        "tool";
      const text = messageText(msg);
      const isError = msg.isError === true;
      const note = summarizeToolResult(text, isError);
      const existing = byId.get(id);
      if (existing) {
        existing.status = isError ? "error" : "completed";
        existing.isError = isError;
        existing.resultNote = note;
        existing.resultText = text.trim() || undefined;
        if (!existing.toolName || existing.toolName === "unknown") existing.toolName = toolName;
      } else {
        pushStep({
          id,
          toolName,
          summary: "",
          status: isError ? "error" : "completed",
          isError,
          resultNote: note,
          resultText: text.trim() || undefined,
        });
      }
      continue;
    }

    if (role === "bashExecution") {
      const command = typeof msg.command === "string" ? msg.command : "";
      const output = typeof msg.output === "string" ? msg.output : "";
      const id = `bash-${++syntheticSeq}`;
      pushStep({
        id,
        toolName: "bash",
        summary: summarizeToolArgs("bash", { command }),
        status: "completed",
        isError: false,
        argsText: command || undefined,
        resultNote: output.trim() ? summarizeToolResult(output, false) : undefined,
        resultText: output.trim() || undefined,
      });
    }
  }

  return { prompt, steers, steps, result };
}

/** Split prompt text into display lines with an optional truncation marker. */
export function truncatePromptLines(prompt: string, maxLines = PROMPT_MAX_LINES): { lines: string[]; truncated: boolean } {
  const lines = prompt.replace(/\r\n/g, "\n").split("\n");
  if (lines.length <= maxLines) return { lines, truncated: false };
  const kept = lines.slice(0, maxLines);
  const hidden = lines.length - maxLines;
  kept.push(`… (${hidden} more line${hidden === 1 ? "" : "s"} truncated — scroll source session for full prompt)`);
  return { lines: kept, truncated: true };
}

export function stepStatusIcon(status: StepStatus): string {
  if (status === "completed") return "✓";
  if (status === "error") return "✗";
  return "⠹";
}

/** Format one step row without theme colors: `✓ read   path/to/file.ts`. */
export function formatStepLine(step: BriefStep, opts?: { includeResultNote?: boolean }): string {
  const icon = stepStatusIcon(step.status);
  const name = step.toolName || "tool";
  const padName = name.length < 6 ? name.padEnd(6) : name;
  const parts = [icon, padName];
  if (step.summary) parts.push(step.summary);
  let line = parts.join(" ");
  if (opts?.includeResultNote !== false && step.resultNote) {
    line += `  · ${step.resultNote}`;
  }
  return line;
}
