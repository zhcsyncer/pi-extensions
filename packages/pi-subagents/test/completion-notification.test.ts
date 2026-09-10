import { describe, expect, it } from "vitest";
import { formatCompletionNotification, NOTIFICATION_MAX_BYTES } from "../src/completion-notification.js";
import type { AgentRecord } from "../src/types.js";
import { createLifetimeUsage } from "../src/usage.js";

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1", type: "general-purpose", description: "Collect evidence", status: "completed",
    result: "Final report", toolUses: 2, startedAt: 100, completedAt: 200,
    lifetimeUsage: createLifetimeUsage(), compactionCount: 0, completionDelivery: "steer",
    ...overrides,
  };
}

function bounded(content: string) {
  expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(NOTIFICATION_MAX_BYTES);
  expect(content).not.toContain("\uFFFD");
}

function resultFrom(content: string): string {
  return /<result>([\s\S]*?)<\/result>/.exec(content)![1]
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

describe("completion notification content budget", () => {
  it("includes the entire report, including whitespace and the conclusion beyond the old preview cap", () => {
    const report = "  \n" + "Evidence.\n".repeat(600) + "FINAL CONCLUSION\n  ";
    const content = formatCompletionNotification([record({ result: report })]);
    bounded(content);
    expect(resultFrom(content)).toBe(report);
    expect(content).not.toContain("truncated");
  });

  it("accepts exactly 16 KiB including metadata and truncates one byte over with an actionable ID", () => {
    const base = record({ result: "x" });
    const overhead = Buffer.byteLength(formatCompletionNotification([base])) - 1;
    base.result = "x".repeat(NOTIFICATION_MAX_BYTES - overhead);
    const exact = formatCompletionNotification([base]);
    expect(Buffer.byteLength(exact)).toBe(NOTIFICATION_MAX_BYTES);
    expect(resultFrom(exact)).toBe(base.result);
    base.result += "y";
    const over = formatCompletionNotification([base]);
    bounded(over);
    expect(over).toContain('[Report truncated. Retrieve full output: get_subagent_result(agent_id="agent-1").]');
  });

  it.each(["&", "<>&", "证据𠮷", "🧪&<>"])("counts UTF-8 and escaping without breaking characters or entities: %s", (text) => {
    const report = text.repeat(20_000);
    const content = formatCompletionNotification([record({ result: report })]);
    bounded(content);
    const preview = resultFrom(content).split("\n[Report truncated.")[0];
    expect(report.startsWith(preview)).toBe(true);
    expect(preview.length).toBeGreaterThan(0);
    expect(content).not.toMatch(/&(?!amp;|lt;|gt;)/);
  });

  it("escapes metadata and the ID as well as report text", () => {
    const content = formatCompletionNotification([record({
      id: "a<&>", description: "desc <&>", toolCallId: "tool<&>", outputFile: "/file<&>",
      status: "error", error: "error<&>", result: "partial<&>",
    })]);
    bounded(content);
    for (const value of ["a", "desc ", "tool", "/file", "error", "partial"]) {
      expect(content).toContain(`${value}&lt;&amp;&gt;`);
    }
  });

  it("includes all group reports fully when the whole group fits", () => {
    const records = [record({ result: "a".repeat(3_000) }), record({ id: "agent-2", result: "b".repeat(3_000) })];
    const content = formatCompletionNotification(records, { group: true, partial: true });
    bounded(content);
    expect(content).toContain("partial — others still running");
    for (const r of records) expect(content).toContain(`<result>${r.result}</result>`);
    expect(content).not.toContain("truncated");
  });

  it("shares one budget across large reports, reserving every member's retrieval entrypoint", () => {
    const records = Array.from({ length: 8 }, (_, i) => record({ id: `agent-${i}`, result: "<&证据>".repeat(4_000) }));
    const content = formatCompletionNotification(records, { group: true });
    bounded(content);
    for (const r of records) expect(content).toContain(`get_subagent_result(agent_id="${r.id}")`);
  });

  it("does not starve a later short complete report when the first report is huge", () => {
    const content = formatCompletionNotification([
      record({ result: "x".repeat(40_000) }), record({ id: "agent-2", result: "short conclusion" }),
    ], { group: true });
    bounded(content);
    expect(content).toContain("<result>short conclusion</result>");
  });

  it("drops overflowing metadata rather than the retrieval key or a report that fits", () => {
    const content = formatCompletionNotification([record({
      description: "<&>".repeat(20_000), error: "error".repeat(20_000), status: "error",
      outputFile: "/".repeat(20_000), toolCallId: "t".repeat(20_000),
      result: "valuable partial report",
    })]);
    bounded(content);
    expect(content).toContain("<task-id>agent-1</task-id>");
    expect(content).toContain("<status>error</status>");
    expect(content).toContain("<metadata-truncated>");
    expect(resultFrom(content)).toBe("valuable partial report");
  });

  it("compacts huge groups to lossless IDs with a shared retrieval instruction", () => {
    const records = Array.from({ length: 200 }, (_, i) => record({ id: `agent-${i}` }));
    const content = formatCompletionNotification(records, { group: true });
    bounded(content);
    expect(content).toContain("Reports and metadata truncated");
    expect(content).toContain("get_subagent_result(agent_id=<ID>)");
    for (const r of records) expect(content).toContain(JSON.stringify(r.id) + "\n");
    expect(content).not.toContain("ID(s) omitted");
  });

  it("bounds even the ID list deterministically and tells how to recover omitted IDs", () => {
    const records = Array.from({ length: 4_000 }, (_, i) => record({ id: `agent-${i.toString().padStart(5, "0")}` }));
    const content = formatCompletionNotification(records, { group: true });
    bounded(content);
    expect(formatCompletionNotification(records, { group: true })).toBe(content);
    const ids = content.split("\n").filter(line => line.startsWith('"agent-'));
    expect(ids).toEqual(records.slice(0, ids.length).map(r => JSON.stringify(r.id)));
    expect(content).toContain(`[${records.length - ids.length} additional agent ID(s) omitted`);
    expect(content).toContain("original Agent launch responses");
  });

  it("never publishes a sliced, unusable retrieval ID even for pathological metadata", () => {
    const content = formatCompletionNotification([record({ id: "x".repeat(20_000) })]);
    bounded(content);
    expect(content).toContain("1 additional agent ID(s) omitted");
    expect(content).not.toContain("xxxxxxxx");
  });
});
