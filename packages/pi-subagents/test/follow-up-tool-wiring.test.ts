import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn(), restoreAgentSession: vi.fn() };
});
import { runAgent, resumeAgent, restoreAgentSession } from "../src/agent-runner.js";
import extension from "../src/index.js";
import { getProjectSubagentsSettingsPath } from "../src/config-paths.js";
import { dirname } from "node:path";
import type { LifetimeUsage } from "../src/usage.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

function harness(options: { usage?: LifetimeUsage; reportUsage?: boolean } = {}) {
  vi.clearAllMocks();
  const previousCwd = process.cwd();
  const cwd = mkdtempSync(join(tmpdir(), "pi-follow-up-tool-"));
  process.chdir(cwd);
  if (options.reportUsage !== undefined) {
    const path = getProjectSubagentsSettingsPath(cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ reportUsage: options.reportUsage }));
  }
  const tools = new Map<string, any>();
  const hooks = new Map<string, any>();
  const entries: any[] = [];
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: vi.fn(), registerMessageRenderer: vi.fn(),
    on: (name: string, handler: any) => hooks.set(name, handler),
    events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    sendMessage: vi.fn(),
  } as any;
  const ctx = {
    cwd, hasUI: false, mode: "print",
    ui: { notify: vi.fn(), setWidget: vi.fn(), setStatus: vi.fn() },
    modelRegistry: { find: vi.fn(), getAll: () => [], getAvailable: () => [] },
    sessionManager: { getBranch: () => entries, getSessionId: () => "parent", getSessionFile: () => undefined },
    getSystemPrompt: () => "parent", isIdle: () => true,
  } as any;
  extension(pi);
  cleanup = async () => {
    await hooks.get("session_shutdown")?.({}, ctx);
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
  };
  const session = {
    dispose: vi.fn(), subscribe: () => () => {}, messages: [],
    getSteeringMessages: () => [], getFollowUpMessages: () => [],
    sessionManager: { getSessionFile: () => join(cwd, "child.jsonl") },
  } as any;
  const snapshot = {
    version: 1, config: {}, systemPrompt: "original", cwd, configCwd: cwd,
    model: { provider: "test", modelId: "original" }, thinkingLevel: "off", isolated: true,
  } as any;
  const usage = options.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
    options.onResumeSnapshot?.(snapshot);
    options.onSessionCreated?.(session);
    options.onAssistantUsage?.(usage);
    return { responseText: "FIRST", session, aborted: false, steered: false };
  });
  let sequence = 0;
  const call = async (name: string, params: any, signal?: AbortSignal) => {
    const toolCallId = `tool-${++sequence}`;
    const result = await tools.get(name).execute(toolCallId, params, signal, undefined, ctx);
    entries.push({ type: "message", message: { ...result, role: "toolResult", toolName: name, toolCallId, timestamp: sequence } });
    return result;
  };
  const launch = (params = {}) => call("Agent", { prompt: "initial", description: "task", subagent_type: "general-purpose", ...params });
  return { call, launch, hooks, ctx, pi, entries, session, snapshot };
}
const text = (result: any) => result.content[0].text as string;

describe("usage rollup tool wiring", () => {
  const spend = { input: 10, output: 5, cacheRead: 20, cacheWrite: 3, cost: 0.75 };

  it("reports foreground spend once on Agent, not its later result lookup", async () => {
    const h = harness({ usage: spend });
    const first = await h.launch();
    expect(first.usage).toMatchObject({ ...spend, cost: { total: 0.75 }, totalTokens: 38 });
    expect(first.details.subagentUsageRollup.agentId).toBe(first.details.agentId);
    const lookup = await h.call("get_subagent_result", { agent_id: first.details.agentId });
    expect(lookup.usage).toBeUndefined();
    expect(lookup.details.subagentUsageRollup).toBeUndefined();
  });

  it("reports background spend on the first completed lookup, never the launch acknowledgement or steering", async () => {
    const h = harness({ usage: spend });
    const launch = await h.launch({ run_in_background: true });
    expect(launch.usage).toBeUndefined();
    const id = launch.details.agentId;
    const results = await Promise.all([
      h.call("get_subagent_result", { agent_id: id, wait: true }),
      h.call("get_subagent_result", { agent_id: id, wait: true }),
    ]);
    expect(results.filter(result => result.usage)).toHaveLength(1);
    expect(results.find(result => result.usage).usage.totalTokens).toBe(38);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "no added spend" });
    const followUp = await h.call("steer_subagent", { agent_id: id, message: "follow up" });
    expect(followUp.usage).toBeUndefined();
    expect((await h.call("get_subagent_result", { agent_id: id, wait: true })).usage).toBeUndefined();
  });

  it("reports only new spend after foreground resume and keeps that watermark after eviction", async () => {
    const h = harness({ usage: spend });
    const first = await h.launch();
    const id = first.details.agentId;
    vi.mocked(resumeAgent).mockImplementation(async (_session, _prompt, options) => {
      options?.onAssistantUsage?.(spend);
      return { text: "SECOND" };
    });
    const second = await h.launch({ resume: id });
    expect(second.usage.totalTokens).toBe(38);
    expect(second.usage.cost.total).toBe(0.75);
    await h.hooks.get("session_start")({}, h.ctx);
    expect((await h.call("get_subagent_result", { agent_id: id })).usage).toBeUndefined();
  });

  it("honours explicit reportUsage false without disabling child accounting", async () => {
    const h = harness({ usage: spend, reportUsage: false });
    const first = await h.launch();
    expect(first.usage).toBeUndefined();
    const archived = h.entries.find(entry => entry.customType === "subagents:record");
    expect(archived.data.lifetimeUsage).toMatchObject(spend);
    expect((await h.call("get_subagent_result", { agent_id: first.details.agentId })).usage).toBeUndefined();
  });
});

describe("failed continuation report retention", () => {
  it.each(["saved session missing", "corrupt JSONL", "original model unavailable"])("keeps the old report separately when restoration fails: %s", async (error) => {
    const h = harness({ usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 3, cost: 0.75 } });
    const first = await h.launch();
    const id = first.details.agentId;
    await h.hooks.get("session_start")({}, h.ctx); // force disk restoration
    writeFileSync(join(h.ctx.cwd, "child.jsonl"), "corrupt JSONL");
    vi.mocked(restoreAgentSession).mockRejectedValue(new Error(error));

    const failed = await h.launch({ resume: id });
    expect(failed.details.status).toBe("error");
    expect(text(failed)).toContain(error);
    expect(text(failed)).toContain("Previous report");
    expect(text(failed)).toContain("NOT the current run's result");
    expect(text(failed)).toContain("FIRST");
    expect(text(failed)).not.toContain("Partial output before the failure:");
    expect(failed.usage).toBeUndefined();
    const terminal = h.entries.filter(entry => entry.customType === "subagents:record").at(-1).data;
    expect(terminal.result).toBeUndefined();
    expect(terminal.previousResult).toBe("FIRST");

    await h.hooks.get("session_start")({}, h.ctx); // error record is evicted too
    const lookup = await h.call("get_subagent_result", { agent_id: id, verbose: true });
    expect(text(lookup)).toContain("FIRST");
    expect(text(lookup)).toContain("Previous report");
    expect(text(lookup)).toContain("Conversation history unavailable");
    expect(lookup.usage).toBeUndefined();
    expect(text(await h.call("steer_subagent", { agent_id: id, message: "again" }))).toContain("explicitly retry");

    const again = await h.launch({ resume: id });
    expect(text(again)).toContain("FIRST"); // repeated failed retries do not erase it
    expect(again.usage).toBeUndefined();
    vi.mocked(restoreAgentSession).mockResolvedValue(h.session);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "SECOND" });
    const success = await h.launch({ resume: id });
    expect(text(success)).toContain("SECOND");
    expect(text(success)).not.toContain("FIRST");
    expect(text(success)).not.toContain("Previous report");
  });
});

describe("follow-up tool runtime wiring", () => {
  it("foreground results show actual model/thinking and resume ignores new route parameters", async () => {
    const h = harness();
    const requested = { provider: "requested", id: "request-model", name: "Requested Model" };
    const effective = { provider: "actual", id: "claude-sonnet", name: "Claude Sonnet" };
    h.ctx.modelRegistry = { find: () => requested, getAll: () => [requested], getAvailable: () => [requested] };
    h.ctx.model = requested;
    h.session.model = effective;
    h.session.thinkingLevel = "high"; // SDK clamps the requested max.
    const initial = await h.launch({ model: "requested/request-model", thinking: "max" });
    expect(initial.details).toMatchObject({ modelName: "sonnet", effort: "high" });
    expect(initial.details.modelInherited).toBeUndefined();
    expect(initial.details.tags).toContain("effort: high");
    expect(initial.details.tags).not.toContain("effort: max");
    vi.mocked(resumeAgent).mockResolvedValue({ text: "CONTINUED" });
    const resumed = await h.call("Agent", {
      resume: initial.details.agentId, prompt: "continue", description: "ignored", subagent_type: "unknown",
      model: "invalid-but-ignored", thinking: "off", max_turns: 1,
    });
    expect(resumed.details).toMatchObject({ modelName: "sonnet", effort: "high" });
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(resumeAgent).toHaveBeenCalledWith(h.session, "continue", expect.any(Object));
    expect(h.session.model).toBe(effective);
    expect(h.session.thinkingLevel).toBe("high");
  });

  it("background resume returns before completion, ignores unrelated parent cancellation, and notifies with the new report", async () => {
    const h = harness();
    vi.useFakeTimers();
    const initial = await h.launch();
    const id = initial.details.agentId;
    let finish!: (value: any) => void;
    vi.mocked(resumeAgent).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const parent = new AbortController();
    const resumed = await h.call("Agent", {
      resume: id, prompt: "continue", description: "ignored", subagent_type: "unknown", model: "invalid-but-ignored", run_in_background: true,
    }, parent.signal);
    expect(text(resumed)).toContain("in background");
    parent.abort();
    expect(vi.mocked(resumeAgent).mock.lastCall?.[2]?.signal?.aborted).toBe(false);
    expect(text(await h.call("get_subagent_result", { agent_id: id }))).toContain("still running");
    finish({ text: "SECOND FULL REPORT" });
    await vi.advanceTimersByTimeAsync(301);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.pi.sendMessage.mock.calls[0][0].content).toContain("SECOND FULL REPORT");
    expect(h.entries.filter(entry => entry.customType === "subagents:record").at(-1).data.result).toBe("SECOND FULL REPORT");
  });

  it("steer_subagent restores evicted metadata and get_result waits for the same tracked execution", async () => {
    const h = harness();
    vi.useFakeTimers();
    const initial = await h.launch();
    const id = initial.details.agentId;
    await h.hooks.get("session_start")({}, h.ctx); // evicts consumed foreground record
    vi.mocked(restoreAgentSession).mockResolvedValue(h.session);
    let finish!: (value: any) => void;
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const followUp = await h.call("steer_subagent", { agent_id: id, message: "new work" });
    expect(text(followUp)).toContain("resumed in background");
    expect(restoreAgentSession).toHaveBeenCalledWith(h.ctx, expect.stringContaining("child.jsonl"), h.snapshot, { pi: h.pi });
    const waiting = h.call("get_subagent_result", { agent_id: id, wait: true });
    finish({ text: "AFTER RESTORE" });
    expect(text(await waiting)).toContain("AFTER RESTORE");
    await vi.advanceTimersByTimeAsync(301);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("a failed restore is visible as an error and cannot be automatically retried by another follow-up", async () => {
    const h = harness();
    const id = (await h.launch()).details.agentId;
    await h.hooks.get("session_start")({}, h.ctx);
    vi.mocked(restoreAgentSession).mockRejectedValue(new Error("saved session missing"));
    await h.call("steer_subagent", { agent_id: id, message: "continue" });
    expect(text(await h.call("get_subagent_result", { agent_id: id, wait: true }))).toContain("saved session missing");
    expect(text(await h.call("steer_subagent", { agent_id: id, message: "again" }))).toContain("explicitly retry");
    expect(restoreAgentSession).toHaveBeenCalledTimes(1);
  });
});
