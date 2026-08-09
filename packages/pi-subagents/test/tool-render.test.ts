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

function taggedTheme() {
  return {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => text,
  } as any;
}

function completedDetails(overrides: Partial<AgentDetails> = {}): AgentDetails {
  return {
    displayName: "Explore",
    description: "find auth",
    subagentType: "Explore",
    toolUses: 3,
    tokens: "lifetime 1.2k token",
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

  it("uses working when a running result has no tool or body activity", () => {
    const out = plain(
      renderAgentLikeResult(
        completedDetails({ status: "running", durationMs: 0, activity: undefined }),
        "",
        { expanded: false },
        theme(),
      ),
    );
    expect(out).toContain("working…");
    expect(out).not.toContain("thinking…");
  });

  it("renders only the terminal duration fragment in semantic accent", () => {
    const component = renderAgentLikeResult(
      completedDetails({ durationMs: 613_000 }),
      "done",
      { expanded: false },
      taggedTheme(),
    );
    const out = plain(component, 160);
    expect(out).toContain("<accent>10 min 13s</accent>");
    expect(out).toContain("<dim>lifetime 1.2k token</dim>");
    expect(out).not.toContain("<accent>lifetime 1.2k token</accent>");
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

  it("explicit isError=false never paints ✗ even when text mentions failed/invalid", async () => {
    const { renderUndetailedResult } = await import("../src/ui/tool-render.js");
    const text =
      'Scheduled "Investigate failed tests" (id: job1, type: cron). Next run: tomorrow.';
    const component = renderUndetailedResult(text, { expanded: false, isError: false }, theme());
    const out = plain(component);
    expect(out).not.toMatch(/✗/);
    expect(out).toContain("Investigate failed tests");
  });

  it("explicit isError=true paints ✗ without relying on keywords", async () => {
    const { renderUndetailedResult } = await import("../src/ui/tool-render.js");
    const component = renderUndetailedResult("all good actually", { expanded: false, isError: true }, theme());
    expect(plain(component)).toMatch(/✗/);
  });

  it("strips terminal controls from undetailed previews", async () => {
    const { renderUndetailedResult } = await import("../src/ui/tool-render.js");
    const component = renderUndetailedResult(
      "\u001b[31mfailed\u001b[0m \u001b]8;;https://evil.invalid\u0007details\u001b]8;;\u0007",
      { expanded: false, isError: true },
      theme(),
    );
    const out = plain(component);
    expect(out).toContain("failed details");
    expect(out).not.toContain("evil.invalid");
    expect(out).not.toContain("\u001b");
  });
});

describe("looksLikeStatusHeader / isFailureDetailsStatus", () => {
  it("does not peel unknown-agent notes or bare Agent:/Type: reports", async () => {
    const { looksLikeStatusHeader, resultBodyText, isFailureDetailsStatus } = await import(
      "../src/ui/tool-render.js",
    );
    expect(looksLikeStatusHeader("Note: Unknown agent type 'x'. Falling back to general-purpose.")).toBe(false);
    const agentReport = "Agent: foo\nType: bar\n\n## Findings\n\nok";
    expect(looksLikeStatusHeader(agentReport.split("\n\n")[0]!)).toBe(false);
    expect(resultBodyText(agentReport)).toContain("Agent: foo");
    expect(resultBodyText(agentReport)).toContain("## Findings");

    const realMeta =
      "Agent: abc\nType: Explore | Status: completed | Tool uses: 1\nDescription: x\n\nbody";
    expect(resultBodyText(realMeta)).toBe("body");

    expect(isFailureDetailsStatus("error")).toBe(true);
    expect(isFailureDetailsStatus("aborted")).toBe(true);
    expect(isFailureDetailsStatus("stopped")).toBe(true);
    expect(isFailureDetailsStatus("completed")).toBe(false);
    expect(isFailureDetailsStatus("queued")).toBe(false);
  });
});

describe("terminal chrome variants", () => {
  it("queued forces queued… not thinking…", () => {
    const out = plain(
      renderAgentLikeResult(
        completedDetails({ status: "queued", durationMs: 0, activity: "thinking…", toolUses: 0, tokens: "" }),
        "",
        { expanded: false },
        theme(),
      ),
    );
    expect(out).toMatch(/queued/);
    expect(out).not.toMatch(/thinking/);
  });

  it("steered shows warning ✓ + Wrapped up (turn limit)", () => {
    const out = plain(
      renderAgentLikeResult(
        completedDetails({ status: "steered", durationMs: 1500 }),
        "partial answer",
        { expanded: false },
        theme(),
      ),
    );
    expect(out).toMatch(/✓/);
    expect(out).toMatch(/Wrapped up \(turn limit\)/);
  });

  it("stopped shows ■ Stopped; aborted shows ✗ Aborted", () => {
    const stopped = plain(
      renderAgentLikeResult(completedDetails({ status: "stopped", durationMs: 900 }), "", { expanded: false }, theme()),
    );
    expect(stopped).toMatch(/■/);
    expect(stopped).toMatch(/Stopped/);

    const aborted = plain(
      renderAgentLikeResult(completedDetails({ status: "aborted", durationMs: 900 }), "", { expanded: false }, theme()),
    );
    expect(aborted).toMatch(/✗/);
    expect(aborted).toMatch(/Aborted/);
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

describe("Agent → invocation → get_subagent_result inherit contract", () => {
  it("detailsFromInvocation preserves modelInherited for result stats", async () => {
    const { detailsFromInvocation } = await import("../src/ui/agent-widget.js");
    const { formatAgentDetailsStats, formatAgentCallMeta, renderAgentLikeResult } = await import(
      "../src/ui/tool-render.js"
    );

    // What Agent tool stores on record.invocation at spawn time.
    const invocation = {
      modelName: "sonnet",
      modelInherited: true,
      thinking: "high" as const,
      runInBackground: true,
    };

    // What get_subagent_result rebuilds into AgentDetails.
    const fromInv = detailsFromInvocation(invocation);
    expect(fromInv.modelName).toBe("sonnet");
    expect(fromInv.modelInherited).toBe(true);
    expect(fromInv.effort).toBe("high");

    const stats = formatAgentDetailsStats(
      {
        displayName: "Explore",
        description: "x",
        subagentType: "Explore",
        toolUses: 1,
        tokens: "1k token",
        durationMs: 1000,
        status: "completed",
        ...fromInv,
      },
      theme(),
    );
    expect(stats).toContain("sonnet (inherit)");
    expect(stats).toContain("effort: high");

    // Call-line chips when record is still live.
    expect(
      formatAgentCallMeta({
        model: invocation.modelName,
        modelInherited: invocation.modelInherited,
        effort: invocation.thinking,
      }),
    ).toBe("sonnet (inherit) · effort: high");

    // Missing record/invocation must not invent inherit.
    expect(formatAgentCallMeta({ extra: ["wait"] })).toBe("wait");
    expect(formatAgentCallMeta({})).toBe("");

    const out = plain(
      renderAgentLikeResult(
        {
          displayName: "Explore",
          description: "x",
          subagentType: "Explore",
          toolUses: 1,
          tokens: "1k token",
          durationMs: 1200,
          status: "completed",
          ...fromInv,
        },
        "Agent completed in 1.2s.\n\nall good",
        { expanded: false },
        theme(),
      ),
    );
    expect(out).toContain("sonnet (inherit)");
    expect(out).toMatch(/⎿\s+Done/);
  });
});
