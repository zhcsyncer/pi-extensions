import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { createAssistantMessageEventStream, type Api, type Model } from "@earendil-works/pi-ai";
import {
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  InteractionUpdateSchema,
  TurnEndedUpdateSchema,
} from "../src/proto/agent_pb.js";
import {
  applyCursorUsage,
  billedUsageFromTurnEnded,
  createCursorAssistantMessage,
} from "../src/stream/pi-adapter.js";
import { processServerMessage } from "../src/stream/server-messages.js";
import { createNativeStreamWriter } from "../src/stream/stream-writer.js";
import type { StreamState } from "../src/stream/types.js";

const composerCost = { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 };
const fableCost = { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 };

function composerModel(): Model<Api> {
  return {
    id: "composer-2.5",
    name: "Composer 2.5",
    provider: "cursor",
    api: "cursor-native" as Api,
    baseUrl: "https://agentn.us.api5.cursor.sh",
    reasoning: false,
    input: ["text"],
    cost: composerCost,
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

function fableModel(): Model<Api> {
  return {
    ...composerModel(),
    id: "claude-fable-5-1",
    name: "Fable 5.1",
    cost: fableCost,
  };
}

function emptyState(over: Partial<StreamState> = {}): StreamState {
  return {
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 0,
    totalTokens: 0,
    turnEnded: false,
    ...over,
  };
}

describe("billedUsageFromTurnEnded", () => {
  it("returns undefined when Cursor omitted every billed field", () => {
    expect(billedUsageFromTurnEnded({})).toBeUndefined();
  });

  it("keeps Cursor's inclusive input and zero cache write as raw billed values", () => {
    expect(
      billedUsageFromTurnEnded({
        inputTokens: 9000n,
        outputTokens: 40n,
        cacheReadTokens: 8000n,
        cacheWriteTokens: 0n,
      }),
    ).toEqual({ input: 9000, output: 40, cacheRead: 8000, cacheWrite: 0 });
  });
});

describe("applyCursorUsage", () => {
  it("prices Composer cache reads from turnEnded instead of treating them as input", () => {
    const output = createCursorAssistantMessage(composerModel());
    applyCursorUsage(
      output,
      composerModel(),
      emptyState({
        totalTokens: 9040,
        billedUsage: { input: 9000, output: 40, cacheRead: 8000, cacheWrite: 0 },
      }),
    );
    expect(output.usage).toEqual({
      input: 1000,
      output: 40,
      cacheRead: 8000,
      cacheWrite: 0,
      totalTokens: 9040,
      cost: {
        input: 0.0005,
        output: 0.0001,
        cacheRead: 0.0016,
        cacheWrite: 0,
        total: 0.0022,
      },
    });
  });

  it("uses the latest checkpoint for context while preserving cumulative billed buckets", () => {
    const output = createCursorAssistantMessage(composerModel());
    applyCursorUsage(
      output,
      composerModel(),
      emptyState({
        // Two internal model calls around one tool execution billed 23,423 tokens in total,
        // while Cursor's final checkpoint says the live context is only 11,775 tokens.
        totalTokens: 11_775,
        billedUsage: { input: 23_308, output: 115, cacheRead: 12_128, cacheWrite: 0 },
      }),
    );
    expect(output.usage).toEqual({
      input: 11_180,
      output: 115,
      cacheRead: 12_128,
      cacheWrite: 0,
      totalTokens: 11_775,
      cost: {
        input: 0.00559,
        output: 0.0002875,
        cacheRead: 0.0024256,
        cacheWrite: 0,
        total: 0.0083031,
      },
    });
  });

  it("does not count a full Fable cache write again as regular input", () => {
    const model = fableModel();
    const output = createCursorAssistantMessage(model);
    applyCursorUsage(
      output,
      model,
      emptyState({
        totalTokens: 1240,
        billedUsage: { input: 1200, output: 40, cacheRead: 0, cacheWrite: 1200 },
      }),
    );
    expect(output.usage).toEqual({
      input: 0,
      output: 40,
      cacheRead: 0,
      cacheWrite: 1200,
      totalTokens: 1240,
      cost: {
        input: 0,
        output: 0.002,
        cacheRead: 0,
        cacheWrite: 0.015,
        total: 0.017,
      },
    });
  });

  it("keeps an uncached billed turn unchanged", () => {
    const output = createCursorAssistantMessage(composerModel());
    applyCursorUsage(
      output,
      composerModel(),
      emptyState({
        totalTokens: 1040,
        billedUsage: { input: 1000, output: 40, cacheRead: 0, cacheWrite: 0 },
      }),
    );
    expect(output.usage).toEqual({
      input: 1000,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1040,
      cost: {
        input: 0.0005,
        output: 0.0001,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.0006000000000000001,
      },
    });
  });

  it("clamps non-cached input when Cursor reports more cache than total input", () => {
    const output = createCursorAssistantMessage(composerModel());
    applyCursorUsage(
      output,
      composerModel(),
      emptyState({
        totalTokens: 120,
        billedUsage: { input: 100, output: 20, cacheRead: 999, cacheWrite: 0 },
      }),
    );
    expect(output.usage).toMatchObject({
      input: 0,
      output: 20,
      cacheRead: 999,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0 },
    });
  });

  it("preserves context without pricing tokenDelta when the bill is missing", () => {
    const output = createCursorAssistantMessage(composerModel());
    const billing = applyCursorUsage(
      output,
      composerModel(),
      emptyState({ outputTokens: 1656, totalTokens: 1040, turnEnded: true }),
    );
    expect(output.usage).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1040,
      cost: { total: 0 },
    });
    expect(billing.status).toBe("unavailable");
  });
});

describe("createNativeStreamWriter usage", () => {
  it("reports intermediate context without inventing a toolUse bill", async () => {
    const stream = createAssistantMessageEventStream();
    const writer = createNativeStreamWriter(stream, composerModel());

    writer.contextSnapshot?.(11_648);
    writer.done("toolUse", emptyState({ outputTokens: 29, totalTokens: 11_648 }));

    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "toolUse",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 11_648,
        cost: { total: 0 },
      },
    });
  });
});

describe("processServerMessage checkpoint", () => {
  it("ignores placeholder zero snapshots but accepts a real decrease", () => {
    const state = emptyState();
    const observed: Array<number | undefined> = [];
    for (const usedTokens of [120_000, 0, 80_000]) {
      processServerMessage(
        create(AgentServerMessageSchema, {
          message: {
            case: "conversationCheckpointUpdate",
            value: create(ConversationStateStructureSchema, {
              tokenDetails: { usedTokens, maxTokens: usedTokens ? 200_000 : 0 },
            }),
          },
        }),
        new Map(),
        [],
        () => {},
        state,
        () => {},
        () => {},
        (_bytes, contextTokens) => observed.push(contextTokens),
      );
      expect(state.totalTokens).toBe(usedTokens || 120_000);
    }
    expect(observed).toEqual([120_000, undefined, 80_000]);
  });
});

describe("processServerMessage turnEnded", () => {
  it("copies billed cache tokens off the wire onto stream state", () => {
    const state = emptyState();
    const message = create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, {
          message: {
            case: "turnEnded",
            value: create(TurnEndedUpdateSchema, {
              inputTokens: 9000n,
              outputTokens: 40n,
              cacheReadTokens: 8000n,
              cacheWriteTokens: 0n,
            }),
          },
        }),
      },
    });
    expect(
      processServerMessage(
        message,
        new Map(),
        [],
        () => {},
        state,
        () => {},
        () => {},
      ),
    ).toBe("work");
    expect(state.turnEnded).toBe(true);
    expect(state.billedUsage).toEqual({
      input: 9000,
      output: 40,
      cacheRead: 8000,
      cacheWrite: 0,
    });
  });
});
