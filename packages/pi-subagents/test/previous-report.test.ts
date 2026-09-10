import { describe, expect, it, vi } from "vitest";
import { formatCompletionNotification, NOTIFICATION_MAX_BYTES } from "../src/completion-notification.js";
import { archiveAgentRecord, openArchivedAgent } from "../src/session-archive.js";
import type { AgentRecord } from "../src/types.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";

function failedRecord(): AgentRecord {
  return {
    id: "retained-report", type: "Explore", description: "Continue research",
    status: "error", error: "Original model unavailable", previousResult: "PREVIOUS_FINDINGS",
    sessionFile: "/missing/child.jsonl", toolUses: 1, startedAt: 1, completedAt: 2,
    lifetimeUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    compactionCount: 0, completionDelivery: "steer",
  };
}

describe("previous report presentation", () => {
  it("keeps the failure headline and labels the previous report in notifications", () => {
    const record = failedRecord();
    const content = formatCompletionNotification([record]);
    expect(content).toContain("Original model unavailable");
    expect(content).toContain("Previous report");
    expect(content).toContain("NOT the current run's result");
    expect(content).toContain("PREVIOUS_FINDINGS");
    record.previousResult = "旧报告".repeat(20_000);
    const longContent = formatCompletionNotification([record]);
    expect(Buffer.byteLength(longContent)).toBeLessThanOrEqual(NOTIFICATION_MAX_BYTES);
    expect(longContent).toContain("Report truncated");
    expect(longContent).toContain("get_subagent_result");
  });

  it("can display the stored report without opening or fabricating child conversation history", () => {
    const archive = archiveAgentRecord(failedRecord())!;
    expect(() => openArchivedAgent(archive)).toThrow(); // normal open remains strict
    const record = openArchivedAgent(archive, true);
    expect(record.session!.messages).toEqual([]);
    expect(record.session!.sessionManager).toBeUndefined();
    const viewer = new ConversationViewer(
      { terminal: { rows: 60, columns: 120 }, requestRender: vi.fn() } as any,
      record.session!, record, undefined,
      { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any,
      vi.fn(),
    );
    const rendered = viewer.render(120).join("\n");
    expect(rendered).toContain("Original model unavailable");
    expect(rendered).toContain("Previous report");
    expect(rendered).toContain("PREVIOUS_FINDINGS");
    expect(rendered).not.toContain("last assistant text before failure");
  });
});
