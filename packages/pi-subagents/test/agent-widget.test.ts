import { describe, expect, it } from "vitest";
import { renderRunningAgentStatus } from "../src/index.js";
import type { WidgetMode } from "../src/types.js";
import {
  ACTIVITY_PHASE_MIN_HOLD_MS,
  ACTIVITY_PHASE_PROMOTION_MS,
  type AgentActivity,
  AgentWidget,
  describeActivity,
  describeCompactActivity,
  fgPreservingNestedStyles,
  formatActiveToolSummary,
  formatLifetimeUsageBreakdown,
  formatMs,
  formatSessionTokens,
  formatSubagentsStatusText,
  getToolActivityPhase,
  styleDuration,
  trackActivityPhaseEnd,
  trackActivityPhaseStart,
} from "../src/ui/agent-widget.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };
  const ansiTheme = {
    fg: (c: string, s: string) => {
      const codes: Record<string, string> = { dim: "2", warning: "33", accent: "35" };
      return `\u001b[${codes[c] ?? "31"}m${s}\u001b[39m`;
    },
    bold: (s: string) => s,
  };

  it("labels lifetime total separately from current context and applies thresholds", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("lifetime 1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe(
      "lifetime 1.2k token (<dim>current ctx 50%</dim>)",
    );
    expect(formatSessionTokens(1234, 70, theme)).toBe(
      "lifetime 1.2k token (<warning>current ctx 70%</warning>)",
    );
    expect(formatSessionTokens(1234, 84, theme)).toBe(
      "lifetime 1.2k token (<warning>current ctx 84%</warning>)",
    );
    expect(formatSessionTokens(1234, 85, theme)).toBe(
      "lifetime 1.2k token (<error>current ctx 85%</error>)",
    );
    expect(formatSessionTokens(1234, 99, theme)).toBe(
      "lifetime 1.2k token (<error>current ctx 99%</error>)",
    );
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe(
      "lifetime 1.2k token (<dim>⇊1</dim>)",
    );
    expect(formatSessionTokens(1234, null, theme, 3)).toBe(
      "lifetime 1.2k token (<dim>⇊3</dim>)",
    );
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe(
      "lifetime 1.2k token (<dim>current ctx 45%</dim> · <dim>⇊2</dim>)",
    );
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe(
      "lifetime 1.2k token (<error>current ctx 88%</error> · <dim>⇊4</dim>)",
    );
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe(
      "lifetime 1.2k token (<dim>current ctx 45%</dim>)",
    );
  });

  it("preserves the outer style after nested annotation styles reset", () => {
    const tokenText = formatSessionTokens(1234, 70, ansiTheme);

    expect(fgPreservingNestedStyles(ansiTheme, "accent", tokenText)).toBe(
      "\u001b[35mlifetime 1.2k token (\u001b[33mcurrent ctx 70%\u001b[39m\u001b[35m)\u001b[39m",
    );
  });
});

describe("lifetime usage and duration formatters", () => {
  it("formats the full usage breakdown and optional cost", () => {
    expect(formatLifetimeUsageBreakdown({
      input: 1_200,
      output: 345,
      cacheRead: 98_700,
      cacheWrite: 40,
      cost: 0.042,
    })).toBe("Lifetime usage: input 1.2k · output 345 · cache read 98.7k · cache write 40 · cost $0.042");
    expect(formatLifetimeUsageBreakdown({
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    })).not.toContain("cost");
  });

  it("formats sub-minute, minute, and hour boundaries without long-second counts", () => {
    expect(formatMs(-500)).toBe("0s");
    expect(formatMs(0)).toBe("0s");
    expect(formatMs(999)).toBe("0.9s");
    expect(formatMs(11_000)).toBe("11s");
    expect(formatMs(59_999)).toBe("59.9s");
    expect(formatMs(60_000)).toBe("1 min 0s");
    expect(formatMs(613_000)).toBe("10 min 13s");
    expect(formatMs(3_600_000)).toBe("1 hr 0 min 0s");
    expect(formatMs(3_661_000)).toBe("1 hr 1 min 1s");
  });

  it("uses only the semantic accent color for the duration fragment", () => {
    const semanticTheme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
    expect(styleDuration(semanticTheme, "10 min 13s")).toBe("<accent>10 min 13s</accent>");
  });
});

describe("renderRunningAgentStatus", () => {
  it("renders running status as separate component lines", () => {
    const theme = { fg: (_c: string, s: string) => s };
    const component = renderRunningAgentStatus("⠋", "effort: xhigh · 4 tool uses", "working…", theme);

    expect(component.render(120).map((line) => line.trimEnd())).toEqual([
      "⠋ effort: xhigh · 4 tool uses",
      "  ⎿  working…",
    ]);
  });
});

describe("AgentWidget", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function makeActivity(): AgentActivity {
    return {
      activeTools: new Map(),
      activeToolPhases: new Map(),
      phaseSummary: {},
      toolUses: 0,
      responseText: "",
      turnCount: 1,
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }

  function makeRecord(id: string, opts: { isBackground?: boolean } = {}) {
    return {
      id,
      type: "general-purpose",
      description: `${id} description`,
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      isBackground: opts.isBackground,
    };
  }

  /** Render the widget for a manager and return the produced lines ("" if nothing rendered). */
  function renderLines(manager: unknown, activityId: string, mode?: () => WidgetMode): string {
    const widget = new AgentWidget(
      manager as any,
      new Map([[activityId, makeActivity()]]),
      mode,
    );
    let factory: any;
    widget.setUICtx({
      setStatus: () => {},
      setWidget: (_key, content) => { factory = content; },
    });
    widget.update();
    if (!factory) return "";
    return factory({ terminal: { columns: 120 }, requestRender: () => {} }, theme)
      .render()
      .join("\n");
  }

  // "all" (and the no-policy constructor default) shows every agent.
  it("shows foreground agents in 'all' mode (and by default)", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground")).toContain("foreground description");
    expect(renderLines(manager, "foreground", () => "all")).toContain("foreground description");
  });

  it("excludes foreground agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground", () => "background")).toBe("");
  });

  // Also covers scheduler-spawned agents (isBackground=true, no `invocation`
  // snapshot): if the filter still keyed off `invocation.runInBackground` —
  // #118's original approach — this would wrongly vanish.
  it("renders background agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    const lines = renderLines(manager, "background", () => "background");
    expect(lines).toContain("Agents");
    expect(lines).toContain("background description");
  });

  // 'background' excludes only agents *known* to be foreground; one with no
  // isBackground flag (e.g. a cross-extension RPC spawn) is kept, not hidden.
  it("keeps agents with no isBackground flag in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("unflagged", {})] };
    expect(renderLines(manager, "unflagged", () => "background")).toContain("unflagged description");
  });

  it("prefers record lifetime metrics over a stale activity mirror after resume", () => {
    const record = makeRecord("resumed", { isBackground: true });
    record.toolUses = 7;
    record.lifetimeUsage = {
      input: 1_200,
      output: 300,
      cacheRead: 500_000,
      cacheWrite: 50,
    };
    const manager = { listAgents: () => [record] };

    const lines = renderLines(manager, "resumed", () => "background");
    expect(lines).toContain("7 tool uses");
    expect(lines).toContain("lifetime 1.6k token");
    expect(lines).not.toContain("lifetime 501.6k token");
  });

  // "off" hides the widget entirely — even a background agent renders nothing.
  it("renders nothing in 'off' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    expect(renderLines(manager, "background", () => "off")).toBe("");
  });
});

describe("formatSubagentsStatusText", () => {
  it("formats running/queued counts and returns undefined when idle", () => {
    expect(formatSubagentsStatusText(0, 0)).toBeUndefined();
    expect(formatSubagentsStatusText(1, 0)).toBe("1 running agent");
    expect(formatSubagentsStatusText(2, 1)).toBe("2 running, 1 queued agents");
  });
});

describe("AgentWidget status bar policy", () => {
  function makeRecord(id: string, opts: { isBackground?: boolean; status?: string } = {}) {
    return {
      id,
      type: "general-purpose",
      description: `${id} description`,
      status: opts.status ?? "running",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      isBackground: opts.isBackground ?? true,
    };
  }

  function captureStatus(mode: () => import("../src/types.js").WidgetMode, agents: unknown[]) {
    const statuses: Array<string | undefined> = [];
    const widget = new AgentWidget(
      { listAgents: () => agents } as any,
      new Map(),
      mode,
    );
    widget.setUICtx({
      setStatus: (_key, text) => { statuses.push(text); },
      setWidget: () => {},
    });
    widget.update();
    return statuses.at(-1);
  }

  it("clears status when the widget tree is active (background mode)", () => {
    expect(captureStatus(() => "background", [makeRecord("bg")])).toBeUndefined();
  });

  it("clears status when the widget tree is active (all mode)", () => {
    expect(captureStatus(() => "all", [makeRecord("fg", { isBackground: false })])).toBeUndefined();
  });

  it("uses compact status only when widget mode is off", () => {
    expect(captureStatus(() => "off", [makeRecord("bg")])).toBe("1 running agent");
    expect(
      captureStatus(() => "off", [
        makeRecord("a"),
        makeRecord("b", { status: "queued" }),
      ]),
    ).toBe("1 running, 1 queued agents");
  });
});

describe("formatActiveToolSummary / describeActivity", () => {
  it("summarizes read/bash/grep args into a detailed step line", () => {
    expect(formatActiveToolSummary("read", { path: "src/a.ts" })).toBe("reading src/a.ts");
    expect(formatActiveToolSummary("bash", { command: 'rg "auth" -n' })).toBe('running rg "auth" -n');
    expect(formatActiveToolSummary("grep", { pattern: "foo", glob: "*.ts" })).toBe('searching "foo" *.ts');
    expect(formatActiveToolSummary("edit", {})).toBe("editing");
  });

  it("strips terminal controls from detailed overlay activity", () => {
    const summary = formatActiveToolSummary("bash", {
      command: "echo \u001b[31mred\u001b[0m \u001b]8;;https://evil.invalid/?token=x\u0007link\u001b]8;;\u0007 中文",
    });

    expect(summary).toBe("running echo red link 中文");
    expect(summary).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
    expect(summary).not.toContain("evil.invalid");
  });

  it("keeps exact tool/body summaries available to the conversation overlay", () => {
    const tools = new Map<string, string>([
      ["c1", "reading src/a.ts"],
      ["c2", "running rg auth"],
    ]);
    expect(describeActivity(tools)).toBe("reading src/a.ts, running rg auth…");
    expect(describeActivity(new Map([["c1", "searching \"x\""]]))).toBe('searching "x"…');
    expect(describeActivity(new Map(), " partial answer ")).toBe("partial answer");
    expect(describeActivity(new Map())).toBe("working…");
  });
});

describe("describeCompactActivity", () => {
  function activity(responseText = ""): AgentActivity {
    return {
      activeTools: new Map(),
      activeToolPhases: new Map(),
      phaseSummary: {},
      toolUses: 0,
      responseText,
      turnCount: 1,
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }

  it("classifies only known tools into coarse, non-sensitive phases", () => {
    expect(getToolActivityPhase("read")).toBe("exploring");
    expect(getToolActivityPhase("web_search")).toBe("exploring");
    expect(getToolActivityPhase("edit")).toBe("editing");
    expect(getToolActivityPhase("bash")).toBe("runningCommands");
    expect(getToolActivityPhase("Agent")).toBe("delegating");
    expect(getToolActivityPhase("custom_private_tool")).toBeUndefined();
  });

  it("keeps fast exact steps hidden until a coarse phase is stable", () => {
    const state = activity();
    state.activeTools.set("r1", "reading secret/customer-file.ts");
    trackActivityPhaseStart(state, "r1", "read", 0);

    expect(describeCompactActivity(state, ACTIVITY_PHASE_PROMOTION_MS - 1)).toBe("working…");
    expect(describeCompactActivity(state, ACTIVITY_PHASE_PROMOTION_MS)).toBe("exploring…");
    expect(describeCompactActivity(state, ACTIVITY_PHASE_PROMOTION_MS)).not.toContain("customer-file");
  });

  it("treats short same-phase gaps as continuous and holds a promoted label", () => {
    const state = activity();
    trackActivityPhaseStart(state, "r1", "read", 0);
    trackActivityPhaseEnd(state, "r1", 400);
    trackActivityPhaseStart(state, "g1", "grep", 550);

    expect(describeCompactActivity(state, ACTIVITY_PHASE_PROMOTION_MS)).toBe("exploring…");
    trackActivityPhaseEnd(state, "g1", 900);
    expect(describeCompactActivity(state, ACTIVITY_PHASE_PROMOTION_MS + ACTIVITY_PHASE_MIN_HOLD_MS - 1))
      .toBe("exploring…");
    expect(describeCompactActivity(state, ACTIVITY_PHASE_PROMOTION_MS + ACTIVITY_PHASE_MIN_HOLD_MS))
      .toBe("working…");
  });

  it("holds the old phase before switching to a stable new phase", () => {
    const state = activity();
    trackActivityPhaseStart(state, "r1", "read", 0);
    expect(describeCompactActivity(state, 800)).toBe("exploring…");

    trackActivityPhaseEnd(state, "r1", 850);
    trackActivityPhaseStart(state, "b1", "bash", 900);
    expect(describeCompactActivity(state, 1600)).toBe("exploring…");
    expect(describeCompactActivity(state, 2300)).toBe("running commands…");
  });

  it("keeps continuous known work stable through concurrent known and unknown tools", () => {
    const state = activity();
    trackActivityPhaseStart(state, "b1", "bash", 0);
    trackActivityPhaseStart(state, "r1", "read", 100);
    trackActivityPhaseStart(state, "x1", "custom_private_tool", 200);

    // Later starts do not reset the oldest candidate's promotion clock.
    expect(describeCompactActivity(state, 799)).toBe("working…");
    expect(describeCompactActivity(state, 800)).toBe("running commands…");

    // Nor may another known phase displace a still-truthful visible phase.
    trackActivityPhaseStart(state, "e1", "edit", 900);
    expect(describeCompactActivity(state, 1000)).toBe("running commands…");
    trackActivityPhaseEnd(state, "e1", 1050);
    trackActivityPhaseEnd(state, "x1", 1100);

    // Once bash ends, the continuously active read is already mature. The old
    // label keeps its minimum hold, then switches without a working flash.
    trackActivityPhaseEnd(state, "b1", 1200);
    expect(describeCompactActivity(state, 2200)).toBe("running commands…");
    expect(describeCompactActivity(state, 2300)).toBe("exploring…");
  });

  it("does not reuse a stale same-named phase after rendering was paused", () => {
    const state = activity();
    trackActivityPhaseStart(state, "r1", "read", 0);
    expect(describeCompactActivity(state, 800)).toBe("exploring…");
    trackActivityPhaseEnd(state, "r1", 900);

    // No render occurs while compact UI is hidden. A later read is a new phase,
    // even though the old visible label was never ticked away.
    trackActivityPhaseStart(state, "r2", "read", 5000);
    expect(describeCompactActivity(state, 5000)).toBe("working…");
    expect(describeCompactActivity(state, 5799)).toBe("working…");
    expect(describeCompactActivity(state, 5800)).toBe("exploring…");
  });

  it("uses working for unknown tools and streaming body text on compact surfaces", () => {
    const state = activity("partial answer with implementation details");
    trackActivityPhaseStart(state, "x1", "custom_private_tool", 0);

    expect(describeCompactActivity(state, 5000)).toBe("working…");
    expect(describeActivity(new Map(), state.responseText)).toBe("partial answer with implementation details");
  });
});
