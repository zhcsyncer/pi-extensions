import { describe, expect, it } from "vitest";
import { isContextOverflow, type Api } from "@earendil-works/pi-ai";
import { shouldSuppressCursorOverflow } from "../src/extension/compaction-guard.js";
import type { CursorAssistantMessage } from "../src/stream/context-usage.js";

function input(): Parameters<typeof shouldSuppressCursorOverflow>[0] & {
  lastAssistant: CursorAssistantMessage;
} {
  return {
    reason: "overflow",
    willRetry: false,
    model: { provider: "cursor", id: "composer-2.5", contextWindow: 200_000 },
    reserveTokens: 16384,
    currentContextTokens: 60_762,
    lastAssistant: {
      role: "assistant",
      api: "cursor-native" as Api,
      provider: "cursor",
      model: "composer-2.5",
      content: [],
      stopReason: "stop",
      timestamp: 1,
      usage: {
        input: 55_454,
        output: 429,
        cacheRead: 258_268,
        cacheWrite: 0,
        totalTokens: 60_762,
        cost: {
          input: 0.027727,
          output: 0.0010725,
          cacheRead: 0.0516536,
          cacheWrite: 0,
          total: 0.0804531,
        },
      },
      cursorUsage: {
        version: 1,
        context: { tokens: 60_762, source: "checkpoint", scope: "scope", history: "history" },
        billing: { status: "reported" },
      },
    },
  };
}

describe("Cursor-only silent-overflow guard", () => {
  it("rejects the actual Pi silent-overflow false positive without modifying the bill", () => {
    const event = input();
    const before = structuredClone(event.lastAssistant.usage);
    expect(isContextOverflow(event.lastAssistant, 200_000)).toBe(true);
    expect(shouldSuppressCursorOverflow(event)).toBe(true);
    expect(event.lastAssistant.usage).toEqual(before);
  });

  it.each(["manual", "threshold"])("never cancels %s compaction", (reason) => {
    expect(shouldSuppressCursorOverflow({ ...input(), reason })).toBe(false);
  });

  it("never cancels explicit error overflow recovery", () => {
    const event = input();
    event.willRetry = true;
    event.lastAssistant.stopReason = "error";
    event.lastAssistant.errorMessage = "context_length_exceeded";
    expect(isContextOverflow(event.lastAssistant, 200_000)).toBe(true);
    expect(shouldSuppressCursorOverflow(event)).toBe(false);
  });

  it.each([183_616, 200_001])(
    "keeps real or near-window context %i eligible for compaction",
    (tokens) => {
      const event = input();
      event.lastAssistant.cursorUsage!.context.tokens = tokens;
      event.lastAssistant.usage.totalTokens = tokens;
      event.currentContextTokens = tokens;
      expect(shouldSuppressCursorOverflow(event)).toBe(false);
    },
  );

  it("does not use an estimate to veto a potential real overflow", () => {
    const event = input();
    event.lastAssistant.cursorUsage!.context.source = "estimate";
    expect(shouldSuppressCursorOverflow(event)).toBe(false);
  });

  it("does not hide large new messages after an older small snapshot", () => {
    expect(shouldSuppressCursorOverflow({ ...input(), currentContextTokens: 210_000 })).toBe(false);
  });

  it.each([null, undefined, 0, NaN])(
    "does not suppress when current context is unknown: %s",
    (tokens) => {
      expect(shouldSuppressCursorOverflow({ ...input(), currentContextTokens: tokens })).toBe(
        false,
      );
    },
  );

  it("does not affect another provider or a switched model", () => {
    expect(
      shouldSuppressCursorOverflow({
        ...input(),
        model: { provider: "other", id: "composer-2.5", contextWindow: 200_000 },
      }),
    ).toBe(false);
    expect(
      shouldSuppressCursorOverflow({
        ...input(),
        model: { provider: "cursor", id: "composer-2.5-fast", contextWindow: 200_000 },
      }),
    ).toBe(false);
  });

  it("does not trust absent or inconsistent provider metadata", () => {
    const event = input();
    delete event.lastAssistant.cursorUsage;
    expect(shouldSuppressCursorOverflow(event)).toBe(false);
    const changed = input();
    changed.lastAssistant.usage.totalTokens = 100;
    expect(shouldSuppressCursorOverflow(changed)).toBe(false);
  });

  it("does not suppress an overflow not explained by the cumulative prompt bill", () => {
    const event = input();
    event.lastAssistant.usage.input = 1000;
    event.lastAssistant.usage.cacheRead = 1000;
    expect(shouldSuppressCursorOverflow(event)).toBe(false);
  });
});
