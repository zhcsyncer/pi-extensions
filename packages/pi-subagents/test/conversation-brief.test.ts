import { describe, expect, it } from "vitest";
import {
  buildConversationBrief,
  formatStepLine,
  summarizeToolArgs,
  summarizeToolResult,
  truncatePromptLines,
} from "../src/ui/conversation-brief.js";

describe("summarizeToolArgs", () => {
  it("prefers path for read/write/edit", () => {
    expect(summarizeToolArgs("read", { path: "src/a.ts" })).toBe("src/a.ts");
    expect(summarizeToolArgs("edit", { file_path: "pkg/b.ts", oldText: "x" })).toBe("pkg/b.ts");
  });

  it("prefers command for bash", () => {
    expect(summarizeToolArgs("bash", { command: 'rg "auth" -n' })).toBe('rg "auth" -n');
  });

  it("formats grep pattern + path/glob", () => {
    expect(summarizeToolArgs("grep", { pattern: "auth", path: "src" })).toBe('"auth" src');
    expect(summarizeToolArgs("grep", { pattern: "foo", glob: "*.ts" })).toBe('"foo" *.ts');
  });

  it("falls back to compact JSON", () => {
    expect(summarizeToolArgs("custom", { a: 1, b: "two" })).toBe('{"a":1,"b":"two"}');
  });

  it("truncates long values", () => {
    const long = "x".repeat(200);
    const out = summarizeToolArgs("bash", { command: long }, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("summarizeToolResult", () => {
  it("reports ok with line count for multi-line bodies", () => {
    expect(summarizeToolResult("a\nb\nc", false)).toMatch(/^ok · 3 lines/);
  });

  it("includes a short first-line preview for single-line ok", () => {
    expect(summarizeToolResult("hello world", false)).toBe("ok · hello world");
  });

  it("marks errors", () => {
    expect(summarizeToolResult("boom", true)).toBe("error · boom");
  });
});

describe("buildConversationBrief", () => {
  it("extracts prompt, steps, and final result without dumping tool bodies", () => {
    const brief = buildConversationBrief([
      { role: "user", content: "Find auth files" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll search." },
          { type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "auth", path: "src" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "grep",
        isError: false,
        content: [{ type: "text", text: "src/a.ts:1\nsrc/b.ts:2\nsrc/c.ts:3" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Found three files." }],
      },
    ]);

    expect(brief.prompt).toBe("Find auth files");
    expect(brief.steps).toHaveLength(1);
    expect(brief.steps[0]?.toolName).toBe("grep");
    expect(brief.steps[0]?.status).toBe("completed");
    expect(brief.steps[0]?.summary).toContain("auth");
    expect(brief.steps[0]?.resultNote).toMatch(/ok · 3 lines/);
    expect(brief.steps[0]?.resultText).toContain("src/a.ts");
    // Intermediate assistant chatter is not the final result.
    expect(brief.result).toBe("Found three files.");
  });

  it("keeps running steps open until a toolResult arrives", () => {
    const brief = buildConversationBrief([
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } }],
      },
    ]);
    expect(brief.steps[0]?.status).toBe("running");
    expect(brief.result).toBeUndefined();
  });

  it("marks failed tool results", () => {
    const brief = buildConversationBrief([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "false" } }],
      },
      {
        role: "toolResult",
        toolCallId: "b1",
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "exit 1" }],
      },
    ]);
    expect(brief.steps[0]?.status).toBe("error");
    expect(brief.steps[0]?.isError).toBe(true);
    expect(formatStepLine(brief.steps[0]!).startsWith("✗")).toBe(true);
  });

  it("accepts legacy toolUseId / input shapes from older fixtures", () => {
    const brief = buildConversationBrief([
      {
        role: "assistant",
        content: [{ type: "toolCall", toolUseId: "t1", name: "read", input: { path: "legacy.ts" } }],
      },
      {
        role: "toolResult",
        toolUseId: "t1",
        content: [{ type: "text", text: "ok" }],
      },
    ]);
    expect(brief.steps).toHaveLength(1);
    expect(brief.steps[0]?.summary).toBe("legacy.ts");
    expect(brief.steps[0]?.status).toBe("completed");
  });

  it("captures steer user messages separately from the dispatch prompt", () => {
    const brief = buildConversationBrief([
      { role: "user", content: "original task" },
      { role: "assistant", content: [{ type: "text", text: "working" }] },
      { role: "user", content: "please also check tests" },
    ]);
    expect(brief.prompt).toBe("original task");
    expect(brief.steers).toEqual(["please also check tests"]);
    expect(brief.result).toBe("working");
  });

  it("includes bashExecution as a completed bash step", () => {
    const brief = buildConversationBrief([
      {
        role: "bashExecution",
        command: "ls -la",
        output: "a\nb\n",
      },
    ]);
    expect(brief.steps[0]?.toolName).toBe("bash");
    expect(brief.steps[0]?.summary).toBe("ls -la");
    expect(brief.steps[0]?.status).toBe("completed");
  });
});

describe("truncatePromptLines", () => {
  it("keeps short prompts intact", () => {
    const { lines, truncated } = truncatePromptLines("a\nb\nc", 30);
    expect(truncated).toBe(false);
    expect(lines).toEqual(["a", "b", "c"]);
  });

  it("truncates long prompts with a note", () => {
    const prompt = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const { lines, truncated } = truncatePromptLines(prompt, 30);
    expect(truncated).toBe(true);
    expect(lines).toHaveLength(31);
    expect(lines[30]).toMatch(/10 more lines truncated/);
  });
});

describe("formatStepLine", () => {
  it("renders status icon + tool + summary", () => {
    expect(
      formatStepLine({
        id: "1",
        toolName: "read",
        summary: "src/a.ts",
        status: "completed",
        isError: false,
        resultNote: "ok · 12 lines",
      }),
    ).toBe("✓ read   src/a.ts  · ok · 12 lines");
  });
});
