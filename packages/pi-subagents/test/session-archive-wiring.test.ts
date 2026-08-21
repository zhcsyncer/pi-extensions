import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "../src/index.js";
import { archiveAgentRecord } from "../src/session-archive.js";
import type { AgentRecord } from "../src/types.js";

describe("/agents finished-session wiring", () => {
  let tempDir: string | undefined;
  let previousCwd: string | undefined;
  let previousAgentDir: string | undefined;

  afterEach(() => {
    if (previousCwd) process.chdir(previousCwd);
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    previousCwd = undefined;
    previousAgentDir = undefined;
    vi.restoreAllMocks();
  });

  it("lists a disk-only finished agent by name/status and opens its brief overlay", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-subagent-history-wiring-"));
    const sessionDir = join(tempDir, "sessions");
    const child = SessionManager.create(tempDir, sessionDir, {
      parentSession: "/sessions/parent.jsonl",
    });
    child.appendMessage({ role: "user", content: "Inspect history", timestamp: 1 });
    child.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Complete history" }],
      api: "anthropic-messages",
      provider: "test",
      model: "test-model",
      stopReason: "stop",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 2,
    } as any);

    const record: AgentRecord = {
      id: "abcdef12-archive",
      type: "Explore",
      description: "Inspect archived run",
      status: "completed",
      result: "Complete history",
      toolUses: 1,
      startedAt: 100,
      completedAt: 200,
      sessionFile: child.getSessionFile(),
      completionDelivery: "followUp",
      lifetimeUsage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
    const archive = archiveAgentRecord(record)!;

    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent-dir");
    process.chdir(tempDir);

    const commands = new Map<string, any>();
    const lifecycle = new Map<string, any>();
    const pi = {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
      on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
      events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as any;
    subagentsExtension(pi);

    let rootSelections = 0;
    let finishedSelections = 0;
    let finishedRow = "";
    const custom = vi.fn(async () => undefined);
    const ctx = {
      cwd: tempDir,
      mode: "tui",
      hasUI: true,
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
      sessionManager: {
        getBranch: () => [{ type: "custom", customType: "subagents:record", data: archive }],
      },
      ui: {
        select: vi.fn(async (title: string, options: string[]) => {
          if (title === "Agents" && rootSelections++ === 0) {
            return options.find((option) => option.startsWith("Finished agents in this session"));
          }
          if (title === "Finished agents in this session" && finishedSelections++ === 0) {
            finishedRow = options[0];
            return options[0];
          }
          return undefined;
        }),
        custom,
        notify: vi.fn(),
      },
    } as any;

    await commands.get("agents").handler("", ctx);

    expect(finishedRow).toContain("Explore#abcdef12");
    expect(finishedRow).toContain("completed");
    expect(custom).toHaveBeenCalledOnce();

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });
});
