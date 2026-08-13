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
