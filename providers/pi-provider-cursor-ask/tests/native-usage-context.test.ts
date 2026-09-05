import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { AgentClientMessageSchema, AgentServerMessageSchema } from "../src/proto/agent_pb.js";
import { frameConnectMessage, type BridgeHandle } from "../src/client/bridge.js";
import {
  createCursorNativeStream,
  cleanupAllSessionState,
  setBridgeFactoryForTests,
} from "../src/stream/native-core.js";
import { resetCacheDirForTests } from "../src/utils/cache-dir.js";
import type { CursorAssistantMessage } from "../src/stream/context-usage.js";

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
const user = { role: "user" as const, content: "Read the fixture", timestamp: 1 };
const context: Context = {
  messages: [user],
  tools: [
    {
      name: "read",
      description: "Read a fixture",
      parameters: { type: "object", properties: {} } as never,
    },
  ],
};
let dir: string;
let oldCacheDir: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cursor-native-usage-"));
  oldCacheDir = process.env.PI_CURSOR_CACHE_DIR;
  process.env.PI_CURSOR_CACHE_DIR = dir;
  resetCacheDirForTests();
});
afterEach(() => {
  cleanupAllSessionState();
  setBridgeFactoryForTests();
  resetCacheDirForTests();
  if (oldCacheDir === undefined) delete process.env.PI_CURSOR_CACHE_DIR;
  else process.env.PI_CURSOR_CACHE_DIR = oldCacheDir;
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
});

function setup() {
  let data = (_chunk: Buffer) => {};
  let done = () => {};
  let close = (_code: number) => {};
  let started!: () => void;
  let resumed!: () => void;
  let startedAgain!: () => void;
  let starts = 0;
  const nextReady = new Promise<void>((resolve) => {
    startedAgain = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const resultSent = new Promise<void>((resolve) => {
    resumed = resolve;
  });
  const bridge: BridgeHandle = {
    alive: true,
    reusable: true,
    lastStderr: () => "",
    write(bytes) {
      const msg = fromBinary(AgentClientMessageSchema, bytes.subarray(5));
      if (
        msg.message.case === "execClientMessage" &&
        msg.message.value.message.case === "mcpResult"
      )
        resumed();
    },
    end() {
      if (this.alive) {
        Object.assign(this, { alive: false });
        close(0);
      }
    },
    kill() {
      Object.assign(this, { alive: false });
      close(1);
    },
    onData(cb) {
      data = cb;
    },
    onClose(cb) {
      close = cb;
    },
    openStream() {},
    onStreamDone(cb) {
      done = cb;
    },
  };
  setBridgeFactoryForTests(() => {
    queueMicrotask(++starts === 1 ? started : startedAgain);
    return bridge;
  });
  const stream = createCursorNativeStream({ getAccessToken: async () => "test-only-token" });
  const send = (message: Parameters<typeof create<typeof AgentServerMessageSchema>>[1]) => {
    data(
      frameConnectMessage(
        toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, message)),
      ),
    );
  };
  return { stream, ready, nextReady, resultSent, send, finish: () => done() };
}

describe("native usage across real provider response boundaries", () => {
  it("carries an already-received late receipt through Run end into the next same-model reply", async () => {
    const h = setup();
    const options = { sessionId: "late-receipt" };
    const first = h.stream(model, context, options);
    await h.ready;
    h.send({
      message: {
        case: "execServerMessage",
        value: {
          id: 1,
          execId: "exec-1",
          message: { case: "mcpArgs", value: { toolCallId: "call-1", toolName: "read", args: {} } },
        },
      },
    });
    const toolReply = await first.result();
    h.send({
      message: {
        case: "interactionUpdate",
        value: {
          message: {
            case: "turnEnded",
            value: {
              inputTokens: 9000n,
              outputTokens: 40n,
              cacheReadTokens: 8000n,
              cacheWriteTokens: 0n,
            },
          },
        },
      },
    });
    h.finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = h.stream(
      model,
      {
        ...context,
        messages: [
          user,
          toolReply,
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            isError: false,
            timestamp: 2,
            content: [{ type: "text", text: "fixture contents" }],
          },
          { role: "user", content: "Continue with the next task", timestamp: 3 },
        ],
      },
      options,
    );
    await h.nextReady;
    h.send({
      message: {
        case: "interactionUpdate",
        value: {
          message: {
            case: "turnEnded",
            value: {
              inputTokens: 1000n,
              outputTokens: 20n,
              cacheReadTokens: 0n,
              cacheWriteTokens: 0n,
            },
          },
        },
      },
    });
    h.finish();
    const result = (await second.result()) as CursorAssistantMessage;
    expect(result.cursorUsage?.billing?.carriedReceipts).toBe(1);
    expect(result.usage).toMatchObject({ input: 2000, output: 60, cacheRead: 8000 });
    expect(result.usage.cost.total).toBeCloseTo(0.00275);
    expect(toolReply.usage.cost.total).toBe(0);
  });

  it("uses a checkpoint that arrived after toolUse even if the resumed response has no fresh snapshot", async () => {
    const h = setup();
    const options = { sessionId: "late-context" };
    const first = h.stream(model, context, options);
    await h.ready;
    h.send({
      message: {
        case: "execServerMessage",
        value: {
          id: 1,
          execId: "exec-1",
          message: { case: "mcpArgs", value: { toolCallId: "call-1", toolName: "read", args: {} } },
        },
      },
    });
    const toolReply = await first.result();
    expect(toolReply.stopReason).toBe("toolUse");
    h.send({
      message: {
        case: "conversationCheckpointUpdate",
        value: { tokenDetails: { usedTokens: 220_000, maxTokens: 200_000 } },
      },
    });
    h.send({
      message: {
        case: "conversationCheckpointUpdate",
        value: { tokenDetails: { usedTokens: 0, maxTokens: 0 } },
      },
    });
    const second = h.stream(
      model,
      {
        ...context,
        messages: [
          user,
          toolReply,
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            isError: false,
            timestamp: 2,
            content: [{ type: "text", text: "fixture contents" }],
          },
        ],
      },
      options,
    );
    await h.resultSent;
    h.send({
      message: {
        case: "interactionUpdate",
        value: {
          message: {
            case: "turnEnded",
            value: {
              inputTokens: 600_000n,
              outputTokens: 100n,
              cacheReadTokens: 500_000n,
              cacheWriteTokens: 0n,
            },
          },
        },
      },
    });
    h.finish();
    const result = (await second.result()) as CursorAssistantMessage;
    expect(result.usage.totalTokens).toBeGreaterThanOrEqual(220_000);
    expect(result.usage.totalTokens).toBeLessThan(230_000);
    expect(result.cursorUsage?.context.source).toBe("estimate");
    expect(result.usage).toMatchObject({ input: 100_000, output: 100, cacheRead: 500_000 });
  });
});
