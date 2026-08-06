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

  it("collapsed completed result is Claude Code chrome (✓ stats / ⎿ Done), no body wall", () => {
    const component = renderAgentLikeResult(
      completedDetails({ modelName: "haiku", effort: "high", turnCount: 3 }),
      hugeBody,
      { expanded: false },
      theme(),
    );
    expect(component).toBeInstanceOf(Text);
    const out = plain(component);
    expect(out).toMatch(/^✓/m);
    expect(out).toContain("haiku");
    expect(out).toContain("effort: high");
    expect(out).toMatch(/⎿\s+Done/);
    expect(out).not.toContain("LINE_SHOULD_STAY_COLLAPSED");
    expect(out).not.toContain("detail line 20");
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

  it("running status is spinner + ⎿ activity (Claude Code shape)", () => {
    const component = renderAgentLikeResult(
      completedDetails({ status: "running", durationMs: 0, activity: "reading src/a.ts", toolUses: 2 }),
      "",
      { expanded: false },
      theme(),
    );
    const out = plain(component, 100);
    expect(out).toMatch(/reading src\/a\.ts/);
    expect(out).toMatch(/⎿/);
    expect(out).toContain("2 tool uses");
    expect(out).not.toContain("abc123"); // id stays off the running chrome (CC)
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

describe("resultBodyText header peel", () => {
  it("keeps multi-paragraph errors intact (does not drop first segment)", () => {
    const text =
      'Model not in scope: "foo".\n\nAllowed models (from enabledModels):\n  anthropic/claude';
    expect(resultBodyText(text)).toContain("Model not in scope");
    expect(resultBodyText(text)).toContain("Allowed models");
    expect(firstLinePreview(resultBodyText(text))).toMatch(/Model not in scope/);
  });

  it("still peels Agent completed status headers", () => {
    const text = "Agent completed in 1.2s (3 tool uses).\n\n## Findings\n\nok";
    expect(resultBodyText(text)).toContain("## Findings");
    expect(resultBodyText(text)).not.toMatch(/^Agent completed/);
  });
});

describe("renderUndetailedResult", () => {
  it("does not paint success for plain validation failures", async () => {
    const { renderUndetailedResult } = await import("../src/ui/tool-render.js");
    const text =
      'Model not in scope: "foo".\n\nAllowed models (from enabledModels):\n  anthropic/claude';
    const component = renderUndetailedResult(text, { expanded: false }, theme());
    const out = plain(component);
    expect(out).toMatch(/✗/);
    expect(out).not.toMatch(/✓/);
    expect(out).toMatch(/⎿/);
    expect(out).toMatch(/Model not in scope/);
  });
});

describe("background launch chrome", () => {
  it("renders single ⎿ Running in background line", () => {
    const component = renderAgentLikeResult(
      completedDetails({ status: "background", agentId: "abc", durationMs: 0, toolUses: 0, tokens: "" }),
      "",
      { expanded: false },
      theme(),
    );
    const out = plain(component);
    expect(out).toMatch(/Running in background \(ID: abc\)/);
    expect(out).toMatch(/⎿/);
    expect(out).not.toMatch(/✓/);
  });
});

describe("formatAgentCallMeta / formatAgentDetailsStats", () => {
  it("call meta is empty unless model/effort/bg explicitly set (clean CC title)", async () => {
    const { formatAgentCallMeta } = await import("../src/ui/tool-render.js");
    expect(formatAgentCallMeta({})).toBe("");
    expect(formatAgentCallMeta({ model: "haiku", effort: "high", background: true })).toBe(
      "haiku · effort: high · bg",
    );
    expect(formatAgentCallMeta({ model: "haiku", modelInherited: true })).toBe("haiku (inherit)");
  });

  it("result stats include model (inherit) and effort", async () => {
    const { formatAgentDetailsStats } = await import("../src/ui/tool-render.js");
    const s = formatAgentDetailsStats(
      {
        displayName: "Explore",
        description: "x",
        subagentType: "Explore",
        toolUses: 2,
        tokens: "1.0k token",
        durationMs: 1000,
        status: "completed",
        modelName: "haiku",
        modelInherited: true,
        effort: "high",
        tags: ["effort: high", "background"],
      },
      theme(),
    );
    expect(s).toContain("haiku (inherit)");
    expect(s).toContain("effort: high");
    expect(s).toContain("background");
    expect(s).toContain("2 tool uses");
    // effort not duplicated from tags
    expect(s.match(/effort: high/g)?.length).toBe(1);
  });
});

describe("shortModelLabel", () => {
  it("strips Claude prefix and lowercases", async () => {
    const { shortModelLabel } = await import("../src/ui/agent-widget.js");
    expect(shortModelLabel({ name: "Claude Sonnet 4", id: "claude-sonnet-4" })).toBe("sonnet 4");
    expect(shortModelLabel({ id: "haiku" })).toBe("haiku");
    expect(shortModelLabel(undefined)).toBeUndefined();
  });
});
