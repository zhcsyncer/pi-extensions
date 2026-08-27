import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  archiveAgentRecord,
  listArchivedAgents,
  openArchivedAgent,
} from "../src/session-archive.js";
import type { AgentRecord } from "../src/types.js";

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-12345678",
    type: "Explore",
    description: "Find session history",
    status: "completed",
    result: "done",
    toolUses: 2,
    startedAt: 100,
    completedAt: 200,
    sessionFile: "/sessions/child.jsonl",
    completionDelivery: "followUp",
    lifetimeUsage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 1 },
    compactionCount: 0,
    ...overrides,
  };
}

describe("subagent session archive", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("archives only terminal records backed by a persisted session", () => {
    expect(archiveAgentRecord(record())).toMatchObject({
      id: "agent-12345678",
      status: "completed",
      sessionFile: "/sessions/child.jsonl",
      toolUses: 2,
    });
    expect(archiveAgentRecord(record({ status: "running" }))).toBeUndefined();
    expect(archiveAgentRecord(record({ sessionFile: undefined }))).toBeUndefined();
  });

  it("lists current-branch archives newest first and keeps the latest completion per id", () => {
    const first = archiveAgentRecord(record({ completedAt: 200 }))!;
    const resumed = archiveAgentRecord(record({ completedAt: 400, result: "second" }))!;
    const other = archiveAgentRecord(record({ id: "agent-other", completedAt: 300 }))!;
    const sessionManager = {
      getBranch: () => [
        { type: "custom", customType: "subagents:record", data: first },
        { type: "custom", customType: "unrelated", data: other },
        { type: "custom", customType: "subagents:record", data: other },
        { type: "custom", customType: "subagents:record", data: resumed },
      ],
    } as any;

    const archives = listArchivedAgents(sessionManager);
    expect(archives.map((archive) => archive.id)).toEqual(["agent-12345678", "agent-other"]);
    expect(archives[0].result).toBe("second");
  });

  it("opens a disk-only child session as a read-only ConversationViewer record", () => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-subagent-archive-"));
    const child = SessionManager.create("/repo", tempDir, {
      parentSession: "/sessions/parent.jsonl",
    });
    child.appendMessage({ role: "user", content: "Inspect this", timestamp: 1 });
    child.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Archived answer" }],
      api: "anthropic-messages",
      provider: "test",
      model: "test-model",
      stopReason: "stop",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 2,
    } as any);

    const archive = archiveAgentRecord(record({ sessionFile: child.getSessionFile() }))!;
    const opened = openArchivedAgent(archive);

    expect(opened.sessionFile).toBe(child.getSessionFile());
    expect(opened.session?.messages).toHaveLength(2);
    expect(opened.session?.messages[1]).toMatchObject({ role: "assistant" });
    expect(opened.status).toBe("completed");
  });
});
