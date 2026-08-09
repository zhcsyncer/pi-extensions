import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { getProjectSubagentsSettingsPath } from "../src/config-paths.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const lifecycle = new Map<string, any>();
  const busHandlers = new Map<string, Set<(data: unknown) => unknown>>();
  const emit = vi.fn((event: string, data: unknown) => {
    for (const handler of busHandlers.get(event) ?? []) handler(data);
  });
  const on = vi.fn((event: string, handler: (data: unknown) => unknown) => {
    if (!busHandlers.has(event)) busHandlers.set(event, new Set());
    busHandlers.get(event)!.add(handler);
    return () => busHandlers.get(event)?.delete(handler);
  });
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit, on },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, lifecycle, busHandlers };
}

function uiCtx() {
  return {
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    notify: vi.fn(),
    onTerminalInput: vi.fn(() => vi.fn()),
    getEditorText: vi.fn(() => ""),
    custom: vi.fn(),
  };
}

function ctx(cwd: string, ui = uiCtx()) {
  return {
    hasUI: true,
    ui,
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    getSystemPrompt: () => "parent",
  } as any;
}

const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

const inlineReviewer = {
  name: "reviewer",
  description: "Inline reviewer",
  builtinToolNames: ["read", "grep", "find", "ls"],
  extensions: false,
  skills: false,
  systemPrompt: "Review the supplied input.",
  promptMode: "replace",
};

describe("caller-owned cross-extension spawn", () => {
  let tmpDir: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-caller-owned-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-caller-owned-agentdir-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    process.chdir(tmpDir);
    const settingsPath = getProjectSubagentsSettingsPath(tmpDir);
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      schedulingEnabled: false,
      defaultJoinMode: "async",
      fleetView: true,
    }));

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      const session = {
        dispose: vi.fn(),
        model: { provider: "test-provider", id: "test-model" },
        thinkingLevel: "high",
      } as any;
      options.onSessionCreated?.(session);
      return { responseText: "review-json", session, aborted: false, steered: false };
    });
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns correlated terminal data without nudging the parent conversation", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    const extensionCtx = ctx(tmpDir, ui);
    await lifecycle.get("session_start")?.({}, extensionCtx);

    try {
      const spawn = [...(busHandlers.get("subagents:rpc:spawn") ?? [])][0];
      expect(spawn).toBeTypeOf("function");
      await spawn({
        requestId: "req-review",
        type: "reviewer",
        prompt: "review",
        options: {
          inlineAgentConfig: inlineReviewer,
          completionOwner: "caller",
          correlationId: "route-1",
          description: "Inline reviewer",
          isBackground: true,
          thinkingLevel: "high",
        },
      });
      await flush();

      expect(pi.sendMessage).not.toHaveBeenCalled();
      const completed = pi.events.emit.mock.calls.find((call: any[]) => call[0] === "subagents:completed");
      expect(completed?.[1]).toMatchObject({
        correlationId: "route-1",
        result: "review-json",
        status: "completed",
        requestedThinkingLevel: "high",
        effectiveModel: { provider: "test-provider", modelId: "test-model" },
        effectiveThinkingLevel: "high",
      });
      expect(pi.appendEntry).toHaveBeenCalledWith(
        "subagents:record",
        expect.objectContaining({ correlationId: "route-1", result: "review-json" }),
      );
      expect(ui.onTerminalInput).toHaveBeenCalled();
      expect(ui.setWidget).toHaveBeenCalledWith("agents", undefined);
    } finally {
      await lifecycle.get("session_shutdown")?.({}, extensionCtx);
    }
  });

  it("emits queued caller-owned terminal after shutdown unbinds stop RPC", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);
    const extensionCtx = ctx(tmpDir);
    await lifecycle.get("session_start")?.({}, extensionCtx);
    const spawn = [...(busHandlers.get("subagents:rpc:spawn") ?? [])][0];

    for (let index = 0; index < 5; index++) {
      await spawn({
        requestId: `req-shutdown-${index}`,
        type: "reviewer",
        prompt: "review",
        options: {
          inlineAgentConfig: inlineReviewer,
          completionOwner: "caller",
          correlationId: `route-shutdown-${index}`,
          isBackground: true,
        },
      });
    }

    await lifecycle.get("session_shutdown")?.({}, extensionCtx);

    expect(busHandlers.get("subagents:rpc:stop")?.size ?? 0).toBe(0);
    expect(pi.events.emit.mock.calls).toContainEqual([
      "subagents:failed",
      expect.objectContaining({
        correlationId: "route-shutdown-4",
        status: "stopped",
      }),
    ]);
  });

  it("runs caller-owned orchestration without touching TUI in headless mode", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    const extensionCtx = { ...ctx(tmpDir, ui), hasUI: false } as any;
    await lifecycle.get("session_start")?.({}, extensionCtx);

    try {
      const spawn = [...(busHandlers.get("subagents:rpc:spawn") ?? [])][0];
      await spawn({
        requestId: "req-headless",
        type: "reviewer",
        prompt: "review",
        options: {
          inlineAgentConfig: inlineReviewer,
          completionOwner: "caller",
          correlationId: "route-headless",
          isBackground: true,
        },
      });
      await flush();

      expect(pi.events.emit.mock.calls).toContainEqual([
        "subagents:completed",
        expect.objectContaining({ correlationId: "route-headless", result: "review-json" }),
      ]);
      expect(ui.onTerminalInput).not.toHaveBeenCalled();
      expect(ui.setWidget).not.toHaveBeenCalled();
    } finally {
      await lifecycle.get("session_shutdown")?.({}, extensionCtx);
    }
  });

  it("keeps the ordinary RPC completion nudge when caller ownership is absent", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);
    const extensionCtx = ctx(tmpDir);
    await lifecycle.get("session_start")?.({}, extensionCtx);

    try {
      const spawn = [...(busHandlers.get("subagents:rpc:spawn") ?? [])][0];
      await spawn({
        requestId: "req-default",
        type: "general-purpose",
        prompt: "work",
        options: { description: "ordinary", isBackground: true },
      });
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: "subagent-notification" }),
        { deliverAs: "followUp", triggerTurn: true },
      );
    } finally {
      await lifecycle.get("session_shutdown")?.({}, extensionCtx);
    }
  });
});
