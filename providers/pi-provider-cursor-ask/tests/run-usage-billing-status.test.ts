import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  registerCursorNotifySink,
  registerSessionLifecycleCleanup,
} from "../src/extension/debug-hooks.js";
import {
  CURSOR_BILLING_STATUS_KEY,
  setCursorNotifySink,
  setCursorStatusSink,
} from "../src/stream/debug-log.js";
import { recordRunReceipt, reportRunUsageBoundary } from "../src/stream/run-usage.js";
import { createNativeStreamWriter } from "../src/stream/stream-writer.js";
import type { CursorRunUsage, StreamState } from "../src/stream/types.js";

const originalLifecycleLog = process.env.PI_CURSOR_LIFECYCLE_LOG;

const model: Model<Api> = {
  id: "composer-2.5",
  name: "Composer",
  api: "cursor-native" as Api,
  provider: "cursor",
  baseUrl: "https://agentn.us.api5.cursor.sh",
  reasoning: false,
  input: ["text"],
  cost: { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
};

const bill = { input: 9000, output: 40, cacheRead: 8000, cacheWrite: 0 };
const raw = {
  inputTokens: 9000n,
  outputTokens: 40n,
  cacheReadTokens: 8000n,
  cacheWriteTokens: 0n,
};

function state(runUsage: CursorRunUsage = {}): StreamState {
  return {
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 1656,
    totalTokens: 0,
    turnEnded: false,
    runUsage,
  };
}

function writer() {
  const stream = createAssistantMessageEventStream();
  return {
    stream,
    writer: createNativeStreamWriter(stream, model, {
      messages: [{ role: "user", content: "read the fixture", timestamp: 1 }],
    }),
  };
}

async function readLifecycleEvents(file: string): Promise<Array<Record<string, unknown>>> {
  return vi.waitFor(async () => {
    const text = await readFile(file, "utf8").catch(() => "");
    const lines = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThan(0);
    return lines;
  });
}

describe("Cursor billing status surface", () => {
  let dir: string;
  let logFile: string;
  const notify = vi.fn();
  const status = vi.fn();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-cursor-billing-status-"));
    logFile = join(dir, "lifecycle.jsonl");
    process.env.PI_CURSOR_LIFECYCLE_LOG = logFile;
    notify.mockReset();
    status.mockReset();
    setCursorNotifySink(notify);
    setCursorStatusSink(status);
  });

  afterEach(async () => {
    setCursorNotifySink(undefined);
    setCursorStatusSink(undefined);
    if (originalLifecycleLog === undefined) delete process.env.PI_CURSOR_LIFECYCLE_LOG;
    else process.env.PI_CURSOR_LIFECYCLE_LOG = originalLifecycleLog;
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("logs a missing receipt at a run boundary without footer status or chat notify", async () => {
    reportRunUsageBoundary({}, "transport_close");

    const events = await readLifecycleEvents(logFile);
    expect(events.some((event) => event.event === "usage_run_unsettled")).toBe(true);
    expect(events.find((event) => event.event === "usage_run_unsettled")).toMatchObject({
      reason: "transport_close",
      status: "receipt_missing",
    });
    expect(status).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("logs an unconsumed receipt without footer status or chat notify", async () => {
    reportRunUsageBoundary({ billedUsage: bill }, "stream_end");

    const events = await readLifecycleEvents(logFile);
    expect(events.find((event) => event.event === "usage_incomplete")).toMatchObject({
      reason: "stream_end",
      status: "receipt_unreported",
    });
    expect(status).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not surface billing incompleteness through notify or footer status", () => {
    const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
    registerCursorNotifySink({
      on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    } as unknown as ExtensionAPI);

    const uiNotify = vi.fn();
    const uiSetStatus = vi.fn();
    handlers.get("session_start")?.[0]?.(undefined, {
      hasUI: true,
      ui: { notify: uiNotify, setStatus: uiSetStatus },
    } as unknown as ExtensionContext);

    reportRunUsageBoundary({ billedUsage: bill }, "stream_end");

    expect(uiNotify).not.toHaveBeenCalled();
    expect(uiSetStatus).not.toHaveBeenCalled();
  });

  it("logs a partial bill without footer status and still clears leftover status on a complete receipt", async () => {
    const partialState = state();
    recordRunReceipt(partialState, bill, { ...raw, cacheWriteTokens: undefined });
    const partial = writer();
    partial.writer.done("stop", partialState);
    await partial.stream.result();

    const events = await readLifecycleEvents(logFile);
    expect(events.some((event) => event.event === "usage_incomplete")).toBe(true);
    expect(status).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();

    const completeState = state();
    recordRunReceipt(completeState, bill, raw);
    const complete = writer();
    complete.writer.done("stop", completeState);
    await complete.stream.result();

    expect(status).toHaveBeenCalledWith(CURSOR_BILLING_STATUS_KEY, undefined);
    expect(notify).not.toHaveBeenCalled();
  });

  it("clears the footer marker when the session switches", () => {
    const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
    registerSessionLifecycleCleanup({
      on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    } as unknown as ExtensionAPI);

    const uiSetStatus = vi.fn();
    handlers.get("session_before_switch")?.[0]?.(undefined, {
      hasUI: true,
      ui: { setStatus: uiSetStatus },
      sessionManager: {
        getSessionId: () => "session-1",
        getLeafId: () => "leaf-1",
      },
    } as unknown as ExtensionContext);

    expect(uiSetStatus).toHaveBeenCalledWith(CURSOR_BILLING_STATUS_KEY, undefined);
  });
});
