/**
 * Deterministic completion-delivery wiring tests.
 *
 * These drive the real extension and AgentManager with a mocked child runner.
 * They assert queue/orchestration behavior only; no model is asked to prove that
 * it will follow the delegation prose.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProjectSubagentsSettingsPath } from "../src/config-paths.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { AgentManager } from "../src/agent-manager.js";
import { GroupJoinManager } from "../src/group-join.js";
import { NOTIFICATION_MAX_BYTES } from "../src/completion-notification.js";
import subagentsExtension from "../src/index.js";

interface Harness {
  cwd: string;
  previousCwd: string;
  pi: any;
  tools: Map<string, any>;
  lifecycle: Map<string, any>;
  ctx: any;
}

let active: Harness | undefined;

function makeEventBus() {
  const listeners = new Map<string, Set<(data: unknown) => unknown>>();
  return {
    on: vi.fn((event: string, handler: (data: unknown) => unknown) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return vi.fn(() => listeners.get(event)?.delete(handler));
    }),
    emit: vi.fn((event: string, data: unknown) => {
      for (const handler of listeners.get(event) ?? []) void handler(data);
    }),
  };
}

function makeCtx(cwd: string) {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
    },
    cwd,
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAll: vi.fn(() => []),
      getAvailable: vi.fn(() => []),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "completion-delivery-session"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
    isIdle: vi.fn(() => true),
  } as any;
}

function setup(options: { customAgent?: { name: string; contents: string } } = {}): Harness {
  const previousCwd = process.cwd();
  const cwd = mkdtempSync(join(tmpdir(), "pi-completion-delivery-"));
  const settingsPath = getProjectSubagentsSettingsPath(cwd);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ outputTranscript: false }));

  if (options.customAgent) {
    const agentPath = join(cwd, ".pi", "agents", `${options.customAgent.name}.md`);
    mkdirSync(dirname(agentPath), { recursive: true });
    writeFileSync(agentPath, options.customAgent.contents);
  }

  process.chdir(cwd);
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const events = makeEventBus();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events,
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;

  subagentsExtension(pi);
  active = { cwd, previousCwd, pi, tools, lifecycle, ctx: makeCtx(cwd) };
  return active;
}

function completedRun(overrides: Record<string, unknown> = {}) {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "CHILD-RESULT",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
    ...overrides,
  } as any);
}

async function spawnAgent(h: Harness, params: Record<string, unknown> = {}) {
  return h.tools.get("Agent").execute(
    `tool-${Math.random()}`,
    {
      prompt: "collect evidence",
      description: "collect delegated evidence",
      subagent_type: "general-purpose",
      run_in_background: true,
      ...params,
    },
    undefined,
    undefined,
    h.ctx,
  );
}

function resultText(result: any): string {
  return result.content[0].text;
}

function onlyDelivery(h: Harness) {
  expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
  return h.pi.sendMessage.mock.calls[0] as [any, any];
}

async function bindSession(h: Harness): Promise<void> {
  await h.lifecycle.get("session_start")?.({ reason: "startup" }, h.ctx);
}

afterEach(async () => {
  if (active) {
    await active.lifecycle.get("session_shutdown")?.({}, active.ctx);
    process.chdir(active.previousCwd);
    rmSync(active.cwd, { recursive: true, force: true });
    active = undefined;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("background completion delivery", () => {
  // Pi extensions.md sendMessage contract: while busy, steer waits until the
  // current assistant turn's tool calls finish; followUp waits until no tool
  // calls remain. Neither retracts sibling tools already issued. While idle,
  // triggerTurn starts a response for either mode. This harness verifies our
  // API boundary, not Pi's queues (or a mocked imitation of those queues).
  it.each([
    [true, "steer"], [false, "steer"], [true, "followUp"], [false, "followUp"],
  ] as const)("hands completion to Pi when idle=%s with %s runtime delivery", async (idle, delivery) => {
    completedRun();
    const h = setup();
    h.ctx.isIdle.mockReturnValue(idle);
    vi.useFakeTimers();
    if (delivery === "steer") {
      await spawnAgent(h);
    } else {
      await bindSession(h);
      h.pi.events.emit("subagents:rpc:spawn", {
        requestId: "runtime-delivery", type: "general-purpose", prompt: "detached work",
        options: { description: "runtime delivery", isBackground: true },
      });
    }
    await vi.advanceTimersByTimeAsync(301);
    expect(onlyDelivery(h)[1]).toEqual({ deliverAs: delivery, triggerTurn: true });
  });

  it("delivers a manual Agent-tool background completion as steer and explains the no-duplication contract", async () => {
    completedRun();
    const h = setup();
    vi.useFakeTimers();

    const launch = await spawnAgent(h);
    expect(resultText(launch)).toContain("Completion will be delivered automatically");
    expect(resultText(launch)).toContain("genuinely disjoint work");
    expect(resultText(launch)).toContain("Do not repeat its evidence collection");

    await vi.advanceTimersByTimeAsync(301);

    const [message, options] = onlyDelivery(h);
    expect(message.details.status).toBe("completed");
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  it("uses steer when custom-agent frontmatter resolves the invocation to background", async () => {
    completedRun();
    const h = setup({
      customAgent: {
        name: "background-default",
        contents: `---\ndescription: Background by default\nrun_in_background: true\n---\n\nResearch only.\n`,
      },
    });
    vi.useFakeTimers();

    await spawnAgent(h, {
      subagent_type: "background-default",
      run_in_background: undefined,
    });
    await vi.advanceTimersByTimeAsync(301);

    expect(onlyDelivery(h)[1]).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  it("keeps scheduler completions on the default followUp delivery", async () => {
    completedRun();
    const h = setup();
    vi.useFakeTimers();
    await bindSession(h);

    const scheduled = await h.tools.get("Agent").execute(
      "tool-scheduled",
      {
        prompt: "run later",
        description: "scheduled detached work",
        subagent_type: "general-purpose",
        schedule: "+1s",
      },
      undefined,
      undefined,
      h.ctx,
    );
    expect(resultText(scheduled)).toContain("Scheduled");

    await vi.advanceTimersByTimeAsync(1_201);

    expect(onlyDelivery(h)[1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("keeps cross-extension RPC completions on the default followUp delivery", async () => {
    completedRun();
    const h = setup();
    vi.useFakeTimers();
    await bindSession(h);

    h.pi.events.emit("subagents:rpc:spawn", {
      requestId: "rpc-completion",
      type: "general-purpose",
      prompt: "detached RPC work",
      options: { description: "detached RPC work", isBackground: true },
    });
    await vi.advanceTimersByTimeAsync(201);

    expect(onlyDelivery(h)[1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("returns foreground output inline without sending a background nudge", async () => {
    completedRun();
    const h = setup();
    vi.useFakeTimers();

    const result = await spawnAgent(h, { run_in_background: false });
    expect(resultText(result)).toContain("CHILD-RESULT");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("joins same-turn smart background agents into one steer notification", async () => {
    completedRun();
    const h = setup();
    vi.useFakeTimers();

    await Promise.all([
      spawnAgent(h, { description: "first disjoint lane" }),
      spawnAgent(h, { description: "second disjoint lane" }),
    ]);
    await vi.advanceTimersByTimeAsync(301);

    const [message, options] = onlyDelivery(h);
    expect(message.content).toContain("Background agent group completed");
    expect(message.details.others).toHaveLength(1);
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  it("cancels a held nudge when get_subagent_result consumes it inside the hold window", async () => {
    completedRun();
    const h = setup();
    vi.useFakeTimers();

    const launch = await spawnAgent(h);
    const id = /Agent ID: (\S+)/.exec(resultText(launch))![1];
    await vi.advanceTimersByTimeAsync(100);

    const consumed = await h.tools.get("get_subagent_result").execute(
      "tool-consume",
      { agent_id: id },
      undefined,
      undefined,
      h.ctx,
    );
    expect(resultText(consumed)).toContain("CHILD-RESULT");

    await vi.advanceTimersByTimeAsync(500);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("aborting wait:true leaves the child running and later delivers its recorded steer notification", async () => {
    let resolveRun!: () => void;
    let childSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation(
      (_ctx, _type, _prompt, options) => new Promise((resolve) => {
        childSignal = options.signal;
        resolveRun = () => resolve({
          responseText: "CHILD-RESULT",
          session: { dispose: vi.fn() } as any,
          aborted: false,
          steered: false,
        });
      }) as any,
    );
    const h = setup();
    vi.useFakeTimers();

    const launch = await spawnAgent(h);
    const id = /Agent ID: (\S+)/.exec(resultText(launch))![1];
    const controller = new AbortController();
    const waitOutcome = h.tools.get("get_subagent_result").execute(
      "tool-wait",
      { agent_id: id, wait: true },
      controller.signal,
      undefined,
      h.ctx,
    ).then(
      () => "resolved",
      (error: unknown) => error instanceof Error ? error.name : String(error),
    );

    controller.abort();
    expect(await waitOutcome).toBe("AbortError");
    expect(childSignal?.aborted).toBe(false);

    resolveRun();
    await vi.advanceTimersByTimeAsync(301);

    const [message, options] = onlyDelivery(h);
    expect(message.content).toContain(id);
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  it.each([
    ["error", "error"],
    ["aborted", "aborted"],
    ["stopped", "stopped"],
  ] as const)("keeps steer delivery and settles fleet state for %s completions", async (kind, expectedStatus) => {
    let finishStopped: (() => void) | undefined;
    if (kind === "error") {
      vi.mocked(runAgent).mockRejectedValue(new Error("child failed"));
    } else if (kind === "aborted") {
      completedRun({ aborted: true, responseText: "partial" });
    } else {
      vi.mocked(runAgent).mockImplementation(
        () => new Promise((resolve) => {
          finishStopped = () => resolve({
            responseText: "partial",
            session: { dispose: vi.fn() } as any,
            aborted: true,
            steered: false,
          });
        }) as any,
      );
    }

    const h = setup();
    vi.useFakeTimers();
    if (kind === "stopped") await bindSession(h);

    const launch = await spawnAgent(h);
    const id = /Agent ID: (\S+)/.exec(resultText(launch))![1];
    if (kind === "stopped") {
      h.pi.events.emit("subagents:rpc:stop", { requestId: "stop-terminal", agentId: id });
      finishStopped?.();
    }

    await vi.advanceTimersByTimeAsync(301);

    const [message, options] = onlyDelivery(h);
    expect(message.details.status).toBe(expectedStatus);
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(h.pi.events.emit).toHaveBeenCalledWith(
      "subagents:failed",
      expect.objectContaining({ id, status: expectedStatus }),
    );
    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    expect(registry.hasRunning()).toBe(false);
  });
});

// Re-deliver terminal callbacks to fault-inject duplicate/racing notifications.
// The manager and runner lifecycle remain real; only this callback boundary is
// replayed. Generation mutations model the manager's per-resume epoch contract.
function captureManager() {
  const spy = vi.spyOn(AgentManager.prototype, "spawn");
  return () => spy.mock.instances[0] as any;
}

function launchId(launch: any): string {
  return /Agent ID: (\S+)/.exec(resultText(launch))![1];
}

describe("completion report delivery and execution identity", () => {
  it("delivers a report beyond 500 characters without losing its final conclusion", async () => {
    const report = "Evidence\n".repeat(700) + "FINAL CONCLUSION";
    completedRun({ responseText: report });
    const h = setup();
    vi.useFakeTimers();
    await spawnAgent(h);
    await vi.advanceTimersByTimeAsync(301);
    const [message] = onlyDelivery(h);
    expect(message.content).toContain(`<result>${report}</result>`);
    expect(message.content).not.toContain("truncated");
  });

  it("bounds a truncated notification including transcript metadata and leaves full output retrievable", async () => {
    const report = "FULL EVIDENCE\n".repeat(3_000) + "FINAL CONCLUSION";
    completedRun({ responseText: report });
    const manager = captureManager();
    const h = setup();
    vi.useFakeTimers();
    const id = launchId(await spawnAgent(h));
    const record = manager().getRecord(id);
    record.outputFile = "/" + "very-long-path".repeat(2_000);
    await vi.advanceTimersByTimeAsync(301);
    const [message] = onlyDelivery(h);
    expect(Buffer.byteLength(message.content)).toBeLessThanOrEqual(NOTIFICATION_MAX_BYTES);
    expect(message.content).toContain(`get_subagent_result(agent_id="${id}")`);
    expect(record.resultConsumed).not.toBe(true);
    const retrieved = await h.tools.get("get_subagent_result").execute(
      "retrieve-full", { agent_id: id }, undefined, undefined, h.ctx,
    );
    expect(resultText(retrieved)).toContain(report);
    expect(record.resultConsumed).toBe(true);
  });

  it("keeps one total budget when delivering a group of large reports", async () => {
    completedRun({ responseText: "<&证据>".repeat(8_000) });
    const h = setup();
    vi.useFakeTimers();
    const launches = await Promise.all([spawnAgent(h), spawnAgent(h), spawnAgent(h)]);
    await vi.advanceTimersByTimeAsync(301);
    const [message] = onlyDelivery(h);
    expect(Buffer.byteLength(message.content)).toBeLessThanOrEqual(NOTIFICATION_MAX_BYTES);
    for (const launch of launches) expect(message.content).toContain(`get_subagent_result(agent_id="${launchId(launch)}")`);
  });

  it("suppresses duplicate callbacks for one execution but delivers a later generation", async () => {
    completedRun({ responseText: "report".repeat(5_000) });
    const manager = captureManager();
    const h = setup();
    vi.useFakeTimers();
    const id = launchId(await spawnAgent(h));
    const record = manager().getRecord(id);
    await vi.advanceTimersByTimeAsync(301);
    manager().onComplete(record);
    await vi.advanceTimersByTimeAsync(201);
    onlyDelivery(h);
    expect(record.resultConsumed).not.toBe(true);

    record.runGeneration = (record.runGeneration ?? 0) + 1;
    record.result = "RESUMED REPORT";
    manager().onComplete(record);
    await vi.advanceTimersByTimeAsync(201);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.pi.sendMessage.mock.calls[1][0].content).toContain("RESUMED REPORT");
    manager().onComplete(record);
    await vi.advanceTimersByTimeAsync(201);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it.each(["running", "queued", "completed"] as const)("drops an individual held notification after generation change to %s", async (status) => {
    completedRun();
    const manager = captureManager();
    const h = setup();
    vi.useFakeTimers();
    const id = launchId(await spawnAgent(h));
    await vi.advanceTimersByTimeAsync(100);
    const record = manager().getRecord(id);
    record.runGeneration = (record.runGeneration ?? 0) + 1;
    record.status = status;
    await vi.advanceTimersByTimeAsync(201);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    record.status = "completed";
  });

  it.each(["running", "queued"] as const)("also drops nonterminal %s records without a generation change", async (status) => {
    completedRun();
    const manager = captureManager();
    const h = setup();
    vi.useFakeTimers();
    const id = launchId(await spawnAgent(h));
    await vi.advanceTimersByTimeAsync(100);
    const record = manager().getRecord(id);
    record.status = status;
    await vi.advanceTimersByTimeAsync(201);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    record.status = "completed";
  });

  it("retains the entire 200ms cancellation hold after batch finalization", async () => {
    completedRun();
    const h = setup();
    vi.useFakeTimers();
    const id = launchId(await spawnAgent(h));
    // Smart join finalizes the batch after its 100ms debounce.
    await vi.advanceTimersByTimeAsync(100 + 199);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    await h.tools.get("get_subagent_result").execute(
      "consume-at-deadline", { agent_id: id }, undefined, undefined, h.ctx,
    );
    await vi.advanceTimersByTimeAsync(2);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["last member", "timeout"])("rejects a stale execution resumed during group join, before the %s callback", async (trigger) => {
    let finishSibling!: () => void;
    completedRun();
    vi.mocked(runAgent).mockImplementationOnce(async () => ({
      responseText: "ORIGINAL REPORT", session: { dispose: vi.fn() } as any,
      aborted: false, steered: false,
    }));
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => {
      finishSibling = () => resolve({
        responseText: "SIBLING REPORT", session: { dispose: vi.fn() } as any,
        aborted: false, steered: false,
      });
    }));
    const manager = captureManager();
    const h = setup();
    vi.useFakeTimers();
    const launches = await Promise.all([spawnAgent(h), spawnAgent(h)]);
    await vi.advanceTimersByTimeAsync(100);
    const first = manager().getRecord(launchId(launches[0]));
    // The first completion is still held INSIDE GroupJoinManager, before its
    // delivery callback has even had a chance to capture execution generations.
    first.runGeneration = (first.runGeneration ?? 0) + 1;
    first.result = "RESUMED REPORT";
    if (trigger === "timeout") {
      await vi.advanceTimersByTimeAsync(30_201);
      expect(h.pi.sendMessage).not.toHaveBeenCalled();
    }
    finishSibling();
    await vi.advanceTimersByTimeAsync(201);
    const [message] = onlyDelivery(h);
    expect(message.content).not.toContain(first.id);
    expect(message.content).toContain("SIBLING REPORT");

    manager().onComplete(first);
    await vi.advanceTimersByTimeAsync(201);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.pi.sendMessage.mock.calls[1][0].content).toContain("RESUMED REPORT");
  });

  it("filters stale generations out of a held group, then permits the resumed report", async () => {
    completedRun();
    const manager = captureManager();
    const h = setup();
    vi.useFakeTimers();
    const launches = await Promise.all([spawnAgent(h), spawnAgent(h)]);
    await vi.advanceTimersByTimeAsync(100);
    const stale = manager().getRecord(launchId(launches[0]));
    stale.runGeneration = (stale.runGeneration ?? 0) + 1;
    // Even a very fast resume which is already terminal must not leak into the
    // old group's scheduled callback, or be marked as delivered by that group.
    stale.result = "NEW GENERATION REPORT";
    await vi.advanceTimersByTimeAsync(201);
    const [message] = onlyDelivery(h);
    expect(message.content).not.toContain(stale.id);
    expect(message.content).toContain(launchId(launches[1]));
    manager().onComplete(stale);
    await vi.advanceTimersByTimeAsync(201);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.pi.sendMessage.mock.calls[1][0].content).toContain("NEW GENERATION REPORT");
  });

  it.each(["running", "queued"] as const)("filters a %s group member even without a generation change", async (status) => {
    completedRun();
    const manager = captureManager();
    const h = setup();
    vi.useFakeTimers();
    const launches = await Promise.all([spawnAgent(h), spawnAgent(h)]);
    await vi.advanceTimersByTimeAsync(100);
    const activeRecord = manager().getRecord(launchId(launches[0]));
    activeRecord.status = status;
    await vi.advanceTimersByTimeAsync(201);
    const [message] = onlyDelivery(h);
    expect(message.content).not.toContain(activeRecord.id);
    expect(message.content).toContain(launchId(launches[1]));
    activeRecord.status = "completed";
  });

  it("does not count a rejected send as delivered when a terminal callback is retried", async () => {
    completedRun();
    const manager = captureManager();
    const h = setup();
    vi.useFakeTimers();
    const id = launchId(await spawnAgent(h));
    h.pi.sendMessage.mockImplementationOnce(() => { throw new Error("send rejected"); });
    await vi.advanceTimersByTimeAsync(301);
    manager().onComplete(manager().getRecord(id));
    await vi.advanceTimersByTimeAsync(201);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.pi.sendMessage.mock.calls[1][0].content).toContain(id);
  });

  it("suppresses duplicate group callbacks and overlapping individual callbacks", async () => {
    completedRun();
    const manager = captureManager();
    const groupSpy = vi.spyOn(GroupJoinManager.prototype, "onAgentComplete");
    const h = setup();
    vi.useFakeTimers();
    const launches = await Promise.all([spawnAgent(h), spawnAgent(h)]);
    await vi.advanceTimersByTimeAsync(301);
    const records = launches.map(launch => manager().getRecord(launchId(launch)));
    (groupSpy.mock.instances[0] as any).deliverCb(records, false);
    manager().onComplete(records[0]);
    await vi.advanceTimersByTimeAsync(201);
    onlyDelivery(h);
  });

  it("filters consumed members from a held group without hiding the other report", async () => {
    completedRun();
    const h = setup();
    vi.useFakeTimers();
    const launches = await Promise.all([spawnAgent(h), spawnAgent(h)]);
    await vi.advanceTimersByTimeAsync(100);
    await h.tools.get("get_subagent_result").execute(
      "consume-group-member", { agent_id: launchId(launches[0]) }, undefined, undefined, h.ctx,
    );
    await vi.advanceTimersByTimeAsync(201);
    const [message] = onlyDelivery(h);
    expect(message.content).not.toContain(launchId(launches[0]));
    expect(message.content).toContain(launchId(launches[1]));
  });
});
