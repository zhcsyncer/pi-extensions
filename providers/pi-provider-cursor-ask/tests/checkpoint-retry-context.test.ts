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
import {
  conversationStates,
  deriveConversationKeyFromSessionId,
  getOrHydrateConversation,
} from "../src/stream/session-state.js";
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
  const sent: ReturnType<typeof create<typeof AgentClientMessageSchema>>[] = [];
  let ready!: () => void;
  const requestReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const bridge: BridgeHandle = {
    alive: true,
    reusable: false,
    lastStderr: () => "",
    write(bytes) {
      const message = fromBinary(AgentClientMessageSchema, bytes.subarray(5));
      sent.push(message);
      if (message.message.case === "runRequest") {
        requestTokens = message.message.value.conversationState?.tokenDetails?.usedTokens;
        ready();
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
    sent,
    requestReady,
    get request() {
      const message = sent.find((message) => message.message.case === "runRequest")?.message;
      return message?.case === "runRequest" ? message.value : undefined;
    },
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

describe("blob miss recovery", () => {
  it("fails without a blob reply, durably invalidates the checkpoint, and rebuilds next turn", async () => {
    const peers = [channel(), channel(), channel()];
    let attempts = 0;
    setBridgeFactoryForTests(() => peers[attempts++]!.bridge);
    const streamFn = createCursorNativeStream({ getAccessToken: async () => "test-only-token" });
    const options = { sessionId: "blob-miss" };
    const convKey = deriveConversationKeyFromSessionId(options.sessionId);
    const missingId = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const context = {
      systemPrompt: "Reply briefly",
      messages: [
        { role: "user" as const, content: "Remember the violet lighthouse", timestamp: 1 },
      ],
      tools: [],
    };
    const first = streamFn(model, context, options);
    await peers[0]!.requestReady;
    peers[0]!.send({
      message: {
        case: "conversationCheckpointUpdate",
        value: { rootPromptMessagesJson: [missingId] },
      },
    });
    peers[0]!.send({
      message: {
        case: "interactionUpdate",
        value: { message: { case: "textDelta", value: { text: "Remembered" } } },
      },
    });
    peers[0]!.finish();
    const answer = await first.result();
    expect(answer.stopReason).toBe("stop");
    const oldConversationId = peers[0]!.request!.conversationId;
    const continuedContext = {
      ...context,
      messages: [
        ...context.messages,
        answer,
        { role: "user" as const, content: "Continue", timestamp: 2 },
      ],
    };

    const failed = streamFn(model, continuedContext, options);
    await peers[1]!.requestReady;
    // Prove this is a live checkpoint replay, not a stale-checkpoint discard.
    expect(peers[1]!.request!.conversationState!.rootPromptMessagesJson).toContainEqual(missingId);
    peers[1]!.send({
      message: {
        case: "kvServerMessage",
        value: { id: 7, message: { case: "getBlobArgs", value: { blobId: missingId } } },
      },
    });
    // The old behavior replies empty and parks; check before waiting for the terminal result.
    expect(peers[1]!.sent.filter((message) => message.message.case === "kvClientMessage")).toEqual(
      [],
    );
    const failure = await failed.result();
    expect(failure.stopReason).toBe("error");
    expect(failure.errorMessage).toMatch(/not in the local store.*Refusing to answer empty/);
    expect(peers[1]!.bridge.alive).toBe(false);
    expect(attempts).toBe(2); // No blind retry inside the failed generation.
    expect(conversationStates.get(convKey)!.checkpoint).toBeNull();
    expect(conversationStates.get(convKey)!.conversationId).not.toBe(oldConversationId);

    // A restart must not resurrect the broken checkpoint from disk.
    conversationStates.clear();
    const restored = getOrHydrateConversation(convKey)!;
    expect(restored.checkpoint).toBeNull();
    expect(restored.checkpointSource).toBeUndefined();
    expect(restored.checkpointTurnCount).toBeUndefined();
    expect(restored.checkpointHistoryFingerprint).toBeUndefined();
    expect(restored.conversationId).not.toBe(oldConversationId);

    const retry = streamFn(model, continuedContext, options);
    await peers[2]!.requestReady;
    const rebuilt = peers[2]!.request!;
    expect(rebuilt.conversationId).toBe(restored.conversationId);
    expect(rebuilt.conversationState!.rootPromptMessagesJson).not.toContainEqual(missingId);
    for (const blobId of rebuilt.conversationState!.rootPromptMessagesJson) {
      peers[2]!.send({
        message: {
          case: "kvServerMessage",
          value: { id: 8, message: { case: "getBlobArgs", value: { blobId } } },
        },
      });
    }
    const prompt = peers[2]!.sent
      .flatMap(({ message }) =>
        message.case === "kvClientMessage" && message.value.message.case === "getBlobResult"
          ? [new TextDecoder().decode(message.value.message.value.blobData)]
          : [],
      )
      .join("\n");
    expect(prompt).toContain("Remember the violet lighthouse");
    expect(prompt).toContain("Remembered");
    peers[2]!.finish();
    expect((await retry.result()).stopReason).toBe("stop");
  });
});

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
