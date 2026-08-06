import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, type Component } from "@earendil-works/pi-tui";
import type { AgentDetails } from "../src/ui/agent-widget.js";
import {
  firstLinePreview,
  renderAgentLikeResult,
  resultBodyText,
  toolResultText,
} from "../src/ui/tool-render.js";

beforeAll(() => {
  initTheme("dark", false);
});

function plain(component: Component, width = 120): string {
  return component
    .render(width)
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
    .join("\n");
}

function containerChildren(component: Component): Component[] {
  return ((component as unknown as { children?: Component[] }).children ?? []) as Component[];
}

function theme() {
  return {
    fg: (_c: string, t: string) => t,
    bold: (t: string) => t,
  } as any;
}

function completedDetails(overrides: Partial<AgentDetails> = {}): AgentDetails {
  return {
    displayName: "Explore",
    description: "find auth",
    subagentType: "Explore",
    toolUses: 3,
    tokens: "1.2k token",
    durationMs: 4200,
    status: "completed",
    agentId: "abc123",
    ...overrides,
  };
}

describe("toolResultText / previews", () => {
  it("joins text content blocks", () => {
    expect(
      toolResultText({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb");
  });

  it("strips status header for body preview", () => {
    const full =
      "Agent: abc\nType: Explore | Status: completed | Tool uses: 3\nDescription: x\n\n## Findings\n\n- auth.ts";
    expect(resultBodyText(full)).toContain("## Findings");
    expect(resultBodyText(full)).not.toMatch(/^Agent:/);
    expect(firstLinePreview(resultBodyText(full))).toBe("## Findings");
  });
});

describe("renderAgentLikeResult", () => {
  const hugeBody = [
    "Agent: abc123",
    "Type: Explore | Status: completed | Tool uses: 3",
    "Description: find auth",
    "",
    "# Report",
    "",
    "LINE_SHOULD_STAY_COLLAPSED",
    ...Array.from({ length: 40 }, (_, i) => `detail line ${i}`),
  ].join("\n");

  it("collapsed completed result is a short Text preview without dumping the body wall", () => {
    const component = renderAgentLikeResult(completedDetails(), hugeBody, { expanded: false }, theme());
    expect(component).toBeInstanceOf(Text);
    const out = plain(component);
    expect(out).toMatch(/✓/);
    expect(out).toMatch(/Report|# Report/);
    expect(out).not.toContain("detail line 20");
    expect(out).toMatch(/expand/i);
  });

  it("expanded completed result uses Markdown under a status header", () => {
    const component = renderAgentLikeResult(completedDetails(), hugeBody, { expanded: true }, theme());
    expect(component).toBeInstanceOf(Container);
    const kids = containerChildren(component);
    expect(kids.some((c) => c instanceof Text)).toBe(true);
    expect(kids.some((c) => c instanceof Markdown)).toBe(true);

    const out = plain(component, 100);
    expect(out).toMatch(/✓/);
    expect(out).toContain("detail line 20");
    expect(out).toContain("Report");
  });

  it("running status stays compact", () => {
    const component = renderAgentLikeResult(
      completedDetails({ status: "running", durationMs: 0, activity: "reading src/a.ts" }),
      "",
      { expanded: false },
      theme(),
    );
    const out = plain(component, 100);
    expect(out).toMatch(/running|reading/i);
    expect(out).toContain("abc123");
  });

  it("error collapsed shows error line without full dump", () => {
    const text = "Agent: x\n\nError: boom\n" + "stack\n".repeat(30);
    const component = renderAgentLikeResult(
      completedDetails({ status: "error", error: "boom" }),
      text,
      { expanded: false },
      theme(),
    );
    const out = plain(component, 100);
    expect(out).toMatch(/✗/);
    expect(out).toContain("boom");
    expect(out.split("\n").length).toBeLessThan(6);
  });
});
