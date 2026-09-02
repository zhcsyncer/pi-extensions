import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  AgentServerMessageSchema,
  InteractionUpdateSchema,
  TurnEndedUpdateSchema,
} from "../src/proto/agent_pb.js";
import {
  applyCursorUsage,
  billedUsageFromTurnEnded,
  createCursorAssistantMessage,
} from "../src/stream/pi-adapter.js";
import { processServerMessage } from "../src/stream/server-messages.js";
import type { StreamState } from "../src/stream/types.js";

const composerCost = { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 };

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

  it("keeps a zero cache write as billed, not as 'missing'", () => {
    expect(
      billedUsageFromTurnEnded({
        inputTokens: 1000n,
        outputTokens: 40n,
        cacheReadTokens: 8000n,
        cacheWriteTokens: 0n,
      }),
    ).toEqual({ input: 1000, output: 40, cacheRead: 8000, cacheWrite: 0 });
  });
});

describe("applyCursorUsage", () => {
  it("prices Composer cache reads from turnEnded instead of treating them as input", () => {
    const output = createCursorAssistantMessage(composerModel());
    applyCursorUsage(
      output,
      composerModel(),
      emptyState({
        billedUsage: { input: 1000, output: 40, cacheRead: 8000, cacheWrite: 0 },
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

  it("keeps cache at 0 when turnEnded had no billed split", () => {
    const output = createCursorAssistantMessage(composerModel());
    applyCursorUsage(output, composerModel(), emptyState({ outputTokens: 40, totalTokens: 1040 }));
    expect(output.usage).toMatchObject({
      input: 1000,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1040,
    });
    expect(output.usage.cost.cacheRead).toBe(0);
    expect(output.usage.cost.total).toBeCloseTo(0.0006);
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
              inputTokens: 1000n,
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
    ).toBe(true);
    expect(state.turnEnded).toBe(true);
    expect(state.billedUsage).toEqual({
      input: 1000,
      output: 40,
      cacheRead: 8000,
      cacheWrite: 0,
    });
  });
});
