import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { restoreAgentSession, resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerRpcHandlers, type EventBus } from "../src/cross-extension-rpc.js";
import { archiveAgentRecord } from "../src/session-archive.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";
import { detailsFromInvocation } from "../src/ui/agent-widget.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(), resumeAgent: vi.fn(), restoreAgentSession: vi.fn(),
}));
vi.mock("../src/worktree.js", () => ({
  isWorktreeIsolationEnabled: () => false, pruneWorktrees: vi.fn(),
}));

const requested = { provider: "requested", id: "requested-model", name: "Requested Model" } as any;
const actual = { provider: "actual", id: "claude-sonnet", name: "Claude Sonnet" } as any;
const ctx = { cwd: "/tmp", model: actual } as any;
const pi = {} as any;
const snapshot = {
  version: 1, config: {}, systemPrompt: "Original", cwd: "/tmp", configCwd: "/tmp",
  model: { provider: actual.provider, modelId: actual.id }, thinkingLevel: "high", isolated: true,
} as any;
function session(model = actual, thinkingLevel = "high") {
  return {
    model, thinkingLevel, dispose: vi.fn(), messages: [], subscribe: () => () => {},
    sessionManager: { getSessionFile: () => "/sessions/child.jsonl" },
    getSteeringMessages: () => [], getFollowUpMessages: () => [],
  } as any;
}
let managers: AgentManager[];
function manager() {
  const m = new AgentManager(undefined, 4, undefined, undefined, { pruneWorktreesOnDispose: false });
  managers.push(m);
  return m;
}
beforeEach(() => {
  vi.resetAllMocks();
  managers = [];
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
    const child = session();
    options.onResumeSnapshot?.(snapshot);
    options.onSessionCreated?.(child);
    return { session: child, responseText: "done", aborted: false, steered: false };
  });
  vi.mocked(resumeAgent).mockResolvedValue({ text: "continued" });
});
afterEach(() => { for (const m of managers) m.dispose(); });

describe("effective invocation readback", () => {
  it("replaces requested model and clamped thinking before exposing the session", async () => {
    const m = manager();
    let atSessionCreated: any;
    const { record } = await m.spawnAndWait(pi, ctx, "general-purpose", "work", {
      description: "task", model: requested, thinkingLevel: "max",
      invocation: { modelName: "requested model", thinking: "max", maxTurns: 7, isolated: true },
      onSessionCreated: () => { atSessionCreated = m.listAgents()[0].invocation; },
    });
    expect(atSessionCreated).toMatchObject({
      modelName: "sonnet", modelIdentity: { provider: "actual", modelId: "claude-sonnet" },
      thinking: "high", modelInherited: true, maxTurns: 7, isolated: true,
    });
    expect(detailsFromInvocation(record.invocation)).toMatchObject({ modelName: "sonnet", effort: "high" });
    expect(record.runGeneration).toBe(1);
    const viewer = new ConversationViewer(
      { terminal: { rows: 40 }, requestRender: vi.fn() } as any,
      record.session!, record, undefined,
      { fg: (_: string, text: string) => text, bold: (text: string) => text }, vi.fn(),
    );
    const output = viewer.render(140).join("\n");
    expect(output).toContain("actual/claude-sonnet");
    expect(output).toContain("effort: high");
    expect(output).not.toContain("requested");
    viewer.dispose();
  });

  it("creates invocation metadata for ordinary RPC with no correlation or invocation supplied", async () => {
    const m = manager();
    const listeners = new Map<string, (data: unknown) => void>();
    const events: EventBus = {
      on: (name, handler) => { listeners.set(name, handler); return () => { listeners.delete(name); }; },
      emit: (name, data) => { listeners.get(name)?.(data); },
    };
    registerRpcHandlers({ events, pi, getCtx: () => ctx, manager: m });
    const reply = new Promise<any>((resolve) => events.on("subagents:rpc:spawn:reply:rpc", resolve));
    events.emit("subagents:rpc:spawn", { requestId: "rpc", type: "general-purpose", prompt: "work" });
    const result = await reply;
    expect(result.success).toBe(true);
    await m.waitForAll();
    const record = m.getRecord(result.data.id)!;
    expect(record.correlationId).toBeUndefined();
    expect(record.invocation).toMatchObject({ modelName: "sonnet", thinking: "high" });
    expect(record.effectiveModel).toEqual({ provider: "actual", modelId: "claude-sonnet" });
  });

  it("reads the restored session route rather than stale archive values or the new parent", async () => {
    const first = manager();
    const { record } = await first.spawnAndWait(pi, ctx, "general-purpose", "work", { description: "task" });
    const archived = archiveAgentRecord(record)!;
    const restored = session({ provider: "restored", id: "saved-model", name: "Saved Model" }, "low");
    vi.mocked(restoreAgentSession).mockResolvedValue(restored);
    const next = manager();
    const restoreCtx = {
      cwd: "/tmp", model: requested,
      sessionManager: { getBranch: () => [{ type: "custom", customType: "subagents:record", data: archived }] },
    } as any;
    let atSessionCreated: any;
    const resumed = await next.resume(record.id, "continue", undefined, {
      pi, ctx: restoreCtx,
      onSessionCreated: () => { atSessionCreated = next.getRecord(record.id)!.invocation; },
    });
    expect(atSessionCreated).toMatchObject({
      modelName: "saved model", modelIdentity: { provider: "restored", modelId: "saved-model" }, thinking: "low",
    });
    expect(atSessionCreated.modelInherited).toBeUndefined();
    expect(resumed?.effectiveThinkingLevel).toBe("low");
    expect(resumed?.runGeneration).toBe(2);
    expect(restoreAgentSession).toHaveBeenCalledWith(restoreCtx, "/sessions/child.jsonl", snapshot, { pi });
  });
});
