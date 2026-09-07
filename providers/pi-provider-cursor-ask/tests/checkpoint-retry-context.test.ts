import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentClientMessageSchema, AgentServerMessageSchema } from "../src/proto/agent_pb.js";
import { frameConnectMessage, type BridgeHandle } from "../src/client/bridge.js";
import {
  createCursorNativeStream,
  cleanupAllSessionState,
  setBridgeFactoryForTests,
} from "../src/stream/native-core.js";
import { resetCacheDirForTests } from "../src/utils/cache-dir.js";
import { estimateMessageTokens, type CursorAssistantMessage } from "../src/stream/context-usage.js";

const model: Model<Api> = {
  id: "composer-2.5",
  name: "Composer",
  api: "cursor-native" as Api,
  provider: "cursor",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
};
let dir: string;
let oldCacheDir: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cursor-checkpoint-retry-"));
  oldCacheDir = process.env.PI_CURSOR_CACHE_DIR;
  process.env.PI_CURSOR_CACHE_DIR = dir;
  resetCacheDirForTests();
});
afterEach(() => {
  cleanupAllSessionState();
  setBridgeFactoryForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetCacheDirForTests();
  if (oldCacheDir === undefined) delete process.env.PI_CURSOR_CACHE_DIR;
  else process.env.PI_CURSOR_CACHE_DIR = oldCacheDir;
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
});

function channel() {
  let data = (_chunk: Buffer) => {};
  let closed = (_code: number) => {};
  let done = () => {};
  let requestTokens: number | undefined;
  const bridge: BridgeHandle = {
    alive: true,
    reusable: false,
    lastStderr: () => "",
    write(bytes) {
      const message = fromBinary(AgentClientMessageSchema, bytes.subarray(5));
      if (message.message.case === "runRequest") {
        requestTokens = message.message.value.conversationState?.tokenDetails?.usedTokens;
      }
    },
    openStream() {},
    end() {
      if (!this.alive) return;
      Object.assign(this, { alive: false });
      closed(0);
    },
    kill() {
      if (!this.alive) return;
      Object.assign(this, { alive: false });
      closed(1);
    },
    onData(callback) {
      data = callback;
    },
    onClose(callback) {
      closed = callback;
    },
    onStreamDone(callback) {
      done = callback;
    },
  };
  return {
    bridge,
    get requestTokens() {
      return requestTokens;
    },
    send(message: Parameters<typeof create<typeof AgentServerMessageSchema>>[1]) {
      data(
        frameConnectMessage(
          toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, message)),
        ),
      );
    },
    disconnect() {
      Object.assign(bridge, { alive: false });
      closed(2);
    },
    finish() {
      done();
    },
  };
}

// Real provider retry orchestration, with transport replaced by an isolated test peer.
describe("first-response checkpoint recovery", () => {
  it.each([
    { kind: "transport", placeholder: false },
    { kind: "transport", placeholder: true },
    { kind: "idle", placeholder: false },
  ])(
    "retains context without a fresh checkpoint ($kind, placeholder=$placeholder)",
    async ({ kind, placeholder }) => {
      if (kind === "idle") {
        vi.useFakeTimers({
          toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
        });
        vi.stubEnv("PI_CURSOR_STREAM_IDLE_TIMEOUT_MS", "1000");
      }
      const first = channel();
      const second = channel();
      let resolveFirst!: () => void;
      let resolveSecond!: () => void;
      const firstReady = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      const secondReady = new Promise<void>((resolve) => {
        resolveSecond = resolve;
      });
      let attempts = 0;
      setBridgeFactoryForTests(() => {
        const initial = attempts++ === 0;
        queueMicrotask(initial ? resolveFirst : resolveSecond);
        return initial ? first.bridge : second.bridge;
      });
      const streamFn = createCursorNativeStream({ getAccessToken: async () => "test-only-token" });
      const stream = streamFn(
        model,
        {
          systemPrompt: "Reply briefly",
          messages: [{ role: "user", content: "ping", timestamp: 1 }],
          tools: [],
        },
        { sessionId: "first-reply-retry" },
      );
      await firstReady;
      first.send({
        message: {
          case: "interactionUpdate",
          value: { message: { case: "textDelta", value: { text: "before" } } },
        },
      });
      first.send({
        message: {
          case: "conversationCheckpointUpdate",
          value: { tokenDetails: { usedTokens: 80_000, maxTokens: 200_000 } },
        },
      });
      if (placeholder)
        first.send({
          message: {
            case: "conversationCheckpointUpdate",
            value: { tokenDetails: { usedTokens: 0, maxTokens: 0 } },
          },
        });
      if (kind === "idle") await vi.advanceTimersByTimeAsync(1000);
      else first.disconnect();
      await secondReady;
      expect(second.requestTokens).toBe(placeholder ? 0 : 80_000);
      second.send({
        message: {
          case: "interactionUpdate",
          value: { message: { case: "textDelta", value: { text: " after" } } },
        },
      });
      second.send({
        message: {
          case: "interactionUpdate",
          value: {
            message: {
              case: "turnEnded",
              value: {
                inputTokens: 80_000n,
                outputTokens: 20n,
                cacheReadTokens: 0n,
                cacheWriteTokens: 0n,
              },
            },
          },
        },
      });
      second.finish();
      const result = (await stream.result()) as CursorAssistantMessage;
      expect(result.stopReason).toBe("stop");
      const includedOutput = estimateMessageTokens({ content: [{ type: "text", text: "before" }] });
      expect(result.usage.totalTokens).toBe(
        80_000 + estimateMessageTokens(result) - includedOutput,
      );
      expect(result.cursorUsage?.context.source).toBe("estimate");
    },
  );
});
