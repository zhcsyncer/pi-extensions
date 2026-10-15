import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type ToolResultMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { UsageReporter } from "../src/usage-reporting.js";
import { addUsage, createLifetimeUsage, toLifetimeUsage, type LifetimeUsage } from "../src/usage.js";

function record(id = "agent-a", lifetimeUsage = toLifetimeUsage({ input: 10, output: 5, cacheRead: 30, cacheWrite: 2, cost: 0.5 })): AgentRecord {
  return {
    id, lifetimeUsage, type: "general-purpose", description: "test", status: "completed",
    toolUses: 0, startedAt: 0, completionDelivery: "followUp", compactionCount: 0,
  };
}

function message(report: NonNullable<ReturnType<UsageReporter["claim"]>>, toolName = "Agent"): ToolResultMessage {
  return {
    role: "toolResult", toolName, toolCallId: "call-1", content: [{ type: "text", text: "done" }],
    usage: report.usage, details: { subagentUsageRollup: { ...report.subagentUsageRollup } },
    isError: false, timestamp: 1,
  };
}

const emptyParent = () => ({ getBranch: (): readonly unknown[] => [] });

describe("UsageReporter", () => {
  it("reports foreground spend once, not again on later retrieval or record eviction", () => {
    const reporter = new UsageReporter();
    const parent = emptyParent();
    const agent = record();
    expect(reporter.claim(agent, parent)?.usage.totalTokens).toBe(47);
    expect(reporter.claim(agent, parent)).toBeUndefined();
    expect(reporter.claim(record(), parent)).toBeUndefined();
  });

  it("atomically reserves a claim before concurrent getters return", async () => {
    const reporter = new UsageReporter();
    const parent = emptyParent();
    const agent = record();
    const results = await Promise.all(Array.from({ length: 10 }, async () => reporter.claim(agent, parent)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("reports only growth after resume, with independent token and cost deltas", () => {
    const reporter = new UsageReporter();
    const parent = emptyParent();
    const agent = record();
    reporter.claim(agent, parent);
    const growth = toLifetimeUsage({ input: 3, output: 7, cacheRead: 90, cacheWrite: 1, cost: { input: 0.1, output: 0.2, total: 0.3 } });
    addUsage(agent.lifetimeUsage, growth);
    const next = reporter.claim(agent, parent)!;
    expect(next.usage).toEqual({
      input: 3, output: 7, cacheRead: 90, cacheWrite: 1, totalTokens: 101,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.30000000000000004 },
    });
    expect(next.subagentUsageRollup.cumulative).toEqual(agent.lifetimeUsage);
    expect(reporter.claim(agent, parent)).toBeUndefined();
  });

  it("restores cumulative maxima from actual parent toolResults after restart", () => {
    const parent = SessionManager.inMemory();
    const agent = record();
    const first = new UsageReporter().claim(agent, parent)!;
    parent.appendMessage(message(first));
    addUsage(agent.lifetimeUsage, toLifetimeUsage({ input: 3, cost: 0.25 }));
    const second = new UsageReporter().claim(agent, parent)!;
    expect(second.usage.input).toBe(3);
    parent.appendMessage(message(second, "get_subagent_result"));
    const restarted = new UsageReporter();
    expect(restarted.claim(record(), parent)).toBeUndefined(); // stale archive
    expect(restarted.claim(agent, parent)).toBeUndefined();
    addUsage(agent.lifetimeUsage, toLifetimeUsage({ output: 2 }));
    expect(restarted.claim(agent, parent)?.usage.totalTokens).toBe(2);
  });

  it("carries nested receipts only with the parent's native usage and restores cost watermarks", () => {
    const parent = SessionManager.inMemory();
    const agent = record();
    const reporter = new UsageReporter();
    const claimed = reporter.claim(agent, parent)!;
    reporter.observeToolResult({ type: "tool_result", toolCallId: "root/1/1", parentToolCallId: "root/1",
      toolName: "Agent", input: {}, content: [], isError: false, usage: claimed.usage,
      details: { subagentUsageRollup: claimed.subagentUsageRollup } });
    reporter.observeToolResult({ type: "tool_result", toolCallId: "root/1", parentToolCallId: "root",
      toolName: "bridge", input: {}, content: [], isError: false, details: {} });
    const root = { ...message(claimed, "codemode"), toolCallId: "root", details: { calls: [] } };
    const finalized = reporter.finalizeMessage({ type: "message_end", message: root })!;
    expect(finalized.message).toMatchObject({ usage: claimed.usage,
      details: { calls: [], subagentUsageRollups: [claimed.subagentUsageRollup] } });
    if (finalized.message.role !== "toolResult") throw new Error("Expected the finalized tool result");
    parent.appendMessage(finalized.message);
    expect(new UsageReporter().claim(agent, parent)).toBeUndefined();
    addUsage(agent.lifetimeUsage, toLifetimeUsage({ cost: 0.25 }));
    expect(new UsageReporter().claim(agent, parent)?.usage.cost.total).toBe(0.25);
  });

  it("does not attach nested receipts to a message without persisted native usage", () => {
    const reporter = new UsageReporter();
    const claimed = reporter.claim(record(), emptyParent())!;
    reporter.observeToolResult({ type: "tool_result", toolCallId: "root/1", parentToolCallId: "root",
      toolName: "Agent", input: {}, content: [], isError: false, usage: claimed.usage,
      details: { subagentUsageRollup: claimed.subagentUsageRollup } });
    expect(reporter.finalizeMessage({ type: "message_end",
      message: { ...message(claimed, "codemode"), toolCallId: "root", usage: undefined } })).toBeUndefined();
  });

  it("keeps agents independent in memory and in persisted claims", () => {
    const reporter = new UsageReporter();
    const parent = SessionManager.inMemory();
    const first = reporter.claim(record("a"), parent)!;
    parent.appendMessage(message(first));
    expect(reporter.claim(record("b"), parent)?.usage.totalTokens).toBe(47);
    expect(new UsageReporter().claim(record("c"), parent)?.usage.totalTokens).toBe(47);
  });

  it("ignores notification/custom entries, unrelated tools and invalid marker envelopes", () => {
    const valid = new UsageReporter().claim(record(), emptyParent())!;
    const tool = message(valid);
    const parent = { getBranch: () => [
      null, [], tool,
      { type: "custom", data: tool.details },
      { type: "message", message: { ...tool, role: "custom" } },
      { type: "message", message: { ...tool, usage: undefined } },
      { type: "message", message: { ...tool, toolName: "steer_subagent" } },
      ...[null, [], { ...valid.subagentUsageRollup, version: 2 }, { ...valid.subagentUsageRollup, cumulative: [] }]
        .map((marker) => ({ type: "message", message: { ...tool, details: { subagentUsageRollup: marker } } })),
    ] };
    expect(new UsageReporter().claim(record(), parent)?.usage.totalTokens).toBe(47);
  });

  it("does not reserve zero or malformed spend and accepts later valid usage", () => {
    const reporter = new UsageReporter();
    const parent = emptyParent();
    const agent = record("a", createLifetimeUsage());
    expect(reporter.claim(agent, parent)).toBeUndefined();
    agent.lifetimeUsage = { input: -1, output: NaN, cacheRead: Infinity, cacheWrite: "bad", cost: -1 } as unknown as LifetimeUsage;
    expect(reporter.claim(agent, parent)).toBeUndefined();
    agent.lifetimeUsage = toLifetimeUsage({ cacheRead: 10 });
    expect(reporter.claim(agent, parent)?.usage).toEqual({
      input: 0, output: 0, cacheRead: 10, cacheWrite: 0, totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });

  it("never lowers the watermark when a lifetime counter regresses or becomes invalid", () => {
    const reporter = new UsageReporter();
    const parent = emptyParent();
    reporter.claim(record(), parent);
    expect(reporter.claim(record("agent-a", toLifetimeUsage({ input: 2, cost: NaN })), parent)).toBeUndefined();
    const next = reporter.claim(record("agent-a", toLifetimeUsage({ input: 12, output: 4, cost: 0.75 })), parent)!;
    expect(next.usage.input).toBe(2);
    expect(next.usage.output).toBe(0);
    expect(next.usage.cost.total).toBe(0.25);
  });

  it("does not share mutable state with records or returned markers", () => {
    const reporter = new UsageReporter();
    const parent = emptyParent();
    const agent = record();
    const result = reporter.claim(agent, parent)!;
    result.subagentUsageRollup.cumulative.input = 0;
    agent.lifetimeUsage.input += 2;
    expect(reporter.claim(agent, parent)?.usage.input).toBe(2);
  });

  it("allows cost-only growth without fabricating tokens or component pricing", () => {
    const reporter = new UsageReporter();
    const parent = emptyParent();
    const agent = record();
    reporter.claim(agent, parent);
    agent.lifetimeUsage.cost = 0.75;
    expect(reporter.claim(agent, parent)?.usage).toMatchObject({
      totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
    });
  });

  it("clears memory on parent replacement, even when the SessionManager object is reused", () => {
    const reporter = new UsageReporter();
    const parent = SessionManager.inMemory();
    reporter.claim(record(), parent);
    parent.newSession();
    expect(reporter.claim(record(), parent)?.usage.totalTokens).toBe(47);
    expect(reporter.claim(record(), SessionManager.inMemory())?.usage.totalTokens).toBe(47);
  });

  it("keeps pending claims on branch growth but drops them when navigating to another path", () => {
    const reporter = new UsageReporter();
    const parent = SessionManager.inMemory();
    const root = parent.appendMessage({ role: "user", content: "root", timestamp: 0 });
    parent.appendMessage({ role: "user", content: "first path", timestamp: 1 });
    reporter.claim(record(), parent);
    parent.appendMessage({ role: "user", content: "normal growth", timestamp: 2 });
    expect(reporter.claim(record(), parent)).toBeUndefined();
    parent.branch(root);
    parent.appendMessage({ role: "user", content: "new path", timestamp: 3 });
    expect(reporter.claim(record(), parent)?.usage.totalTokens).toBe(47);
  });

  it("drops a reservation whose receipt was branched away before another claim observed it", () => {
    const parent = SessionManager.inMemory();
    const root = parent.appendMessage({ role: "user", content: "root", timestamp: 0 });
    const reporter = new UsageReporter();
    const agent = record("child", toLifetimeUsage({ cost: 0.06 }));
    const a = parent.appendMessage(message(reporter.claim(agent, parent)!));
    // No intermediate claim at A's receipt: the reporter last saw the shared root.
    parent.branch(root);
    parent.appendMessage({ role: "user", content: "B", timestamp: 1 });
    const b = reporter.claim(agent, parent)!;
    expect(b.usage.cost.total).toBe(0.06);
    parent.appendMessage(message(b));
    agent.lifetimeUsage = toLifetimeUsage({ cost: 0.08 });
    parent.branch(a);
    const growth = reporter.claim(agent, parent)!;
    expect(growth.usage.cost.total).toBeCloseTo(0.02);
    parent.appendMessage(message(growth));
    expect(reporter.claim(agent, parent)).toBeUndefined();
  });

  it("rebuilds shared-ancestor claims after branching instead of carrying abandoned growth", () => {
    const reporter = new UsageReporter();
    const parent = SessionManager.inMemory();
    const agent = record();
    const root = parent.appendMessage(message(reporter.claim(agent, parent)!));
    addUsage(agent.lifetimeUsage, toLifetimeUsage({ input: 2 }));
    parent.appendMessage(message(reporter.claim(agent, parent)!, "get_subagent_result"));
    expect(reporter.claim(agent, parent)).toBeUndefined();
    parent.branch(root);
    expect(reporter.claim(agent, parent)?.usage.input).toBe(2);
  });

  it("Pi getSessionStats counts native tool-result usage once, including caches and cost", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-usage-reporting-"));
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const settingsManager = SettingsManager.inMemory();
      const resourceLoader = new DefaultResourceLoader({
        cwd: dir, agentDir: dir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      });
      await resourceLoader.reload();
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null,
        modelsStorePath: join(dir, "models-store.json"), allowModelNetwork: false,
      });
      const parent = SessionManager.inMemory(dir);
      ({ session } = await createAgentSession({
        cwd: dir, agentDir: dir, sessionManager: parent, settingsManager, resourceLoader, modelRuntime, noTools: "all",
      }));
      const reporter = new UsageReporter();
      const agent = record("agent-a", toLifetimeUsage({
        input: 10, output: 5, cacheRead: 30, cacheWrite: 2,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
      }));
      parent.appendMessage(message(reporter.claim(agent, parent)!));
      expect(new UsageReporter().claim(record("agent-a", agent.lifetimeUsage), parent)).toBeUndefined();
      addUsage(agent.lifetimeUsage, toLifetimeUsage({ output: 3, cacheRead: 7, cost: { output: 0.25, total: 0.25 } }));
      parent.appendMessage(message(reporter.claim(agent, parent)!, "get_subagent_result"));
      expect(reporter.claim(agent, parent)).toBeUndefined();
      const stats = session.getSessionStats();
      expect(stats.tokens).toEqual({ input: 10, output: 8, cacheRead: 37, cacheWrite: 2, total: 57 });
      expect(stats.cost).toBe(1.25);
      expect(stats.toolResults).toBe(2);
      expect(stats.assistantMessages).toBe(0);
    } finally {
      session?.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
