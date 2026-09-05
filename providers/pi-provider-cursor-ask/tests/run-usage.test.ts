import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type Api, type Model } from "@earendil-works/pi-ai";
import { recordRunReceipt } from "../src/stream/run-usage.js";
import { createNativeStreamWriter } from "../src/stream/stream-writer.js";
import type { CursorRunUsage, StreamState } from "../src/stream/types.js";
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
const bill = { input: 9000, output: 40, cacheRead: 8000, cacheWrite: 0 };
const raw = { inputTokens: 9000n, outputTokens: 40n, cacheReadTokens: 8000n, cacheWriteTokens: 0n };
function writer() {
  const stream = createAssistantMessageEventStream();
  return {
    stream,
    writer: createNativeStreamWriter(stream, model, {
      messages: [{ role: "user", content: "read the fixture", timestamp: 1 }],
    }),
  };
}

describe("Cursor Run receipt accounting", () => {
  it("keeps an absent bill explicitly unavailable on abort instead of inventing token costs", async () => {
    const { stream, writer: output } = writer();
    output.contextSnapshot?.(12_000);
    output.text("partial response");
    output.error("Aborted", "aborted", state());
    const result = (await stream.result()) as CursorAssistantMessage;
    expect(result.usage).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0 },
    });
    expect(result.usage.totalTokens).toBeGreaterThanOrEqual(12_000);
    expect(result.cursorUsage?.billing?.status).toBe("unavailable");
  });

  it("distinguishes a failure before starting an upstream run", async () => {
    const { stream, writer: output } = writer();
    output.error("No credentials", "error");
    expect(((await stream.result()) as CursorAssistantMessage).cursorUsage?.billing?.status).toBe(
      "not-started",
    );
  });

  it("delivers a receipt arriving after a local tool reply to the next writer exactly once", async () => {
    const run: CursorRunUsage = {};
    const before = state(run);
    const first = writer();
    first.writer.done("toolUse", before);
    const pending = (await first.stream.result()) as CursorAssistantMessage;
    expect(pending.cursorUsage?.billing?.status).toBe("pending");
    expect(pending.usage.cost.total).toBe(0);

    // The old parser can receive turnEnded while Pi is executing tools locally.
    recordRunReceipt(before, bill, raw);
    const second = writer();
    second.writer.done("stop", state(run));
    const complete = (await second.stream.result()) as CursorAssistantMessage;
    expect(complete.cursorUsage?.billing?.status).toBe("reported");
    expect(complete.usage).toMatchObject({ input: 1000, output: 40, cacheRead: 8000 });
    expect(complete.usage.cost.total).toBeCloseTo(0.0022);
    expect(pending.usage.cost.total).toBe(0); // Never mutate an already-emitted message.

    recordRunReceipt(before, bill, raw); // duplicate terminal frame
    const third = writer();
    third.writer.done("stop", state(run));
    const duplicate = (await third.stream.result()) as CursorAssistantMessage;
    expect(duplicate.cursorUsage?.billing?.status).toBe("already-reported");
    expect(duplicate.usage.cost.total).toBe(0);
  });

  it("retains a real bill even when the final message is aborted and ignores duplicate finalization", async () => {
    const current = state();
    recordRunReceipt(current, bill, raw);
    const { stream, writer: output } = writer();
    output.error("Aborted", "aborted", current);
    output.done("stop", current);
    output.error("late close", "error", current);
    const result = (await stream.result()) as CursorAssistantMessage;
    expect(result.stopReason).toBe("aborted");
    expect(result.cursorUsage?.billing?.status).toBe("reported");
    expect(result.usage.cost.total).toBeCloseTo(0.0022);
  });

  it("does not price cache-inclusive input at the uncached rate when the split is incomplete", async () => {
    const current = state();
    recordRunReceipt(current, bill, { ...raw, cacheWriteTokens: undefined });
    const { stream, writer: output } = writer();
    output.done("stop", current);
    const result = (await stream.result()) as CursorAssistantMessage;
    expect(result.cursorUsage?.billing).toEqual({
      status: "partial",
      missingFields: ["cacheWrite"],
    });
    expect(result.usage.input).toBe(0);
    expect(result.usage.output).toBe(40);
    expect(result.usage.cacheRead).toBe(8000);
    expect(result.usage.cost.input).toBe(0);
  });

  it("does not mix an unsettled lost Run with a replacement Run's receipt", async () => {
    const lost = state();
    const first = writer();
    first.writer.error("Connection lost", "error", lost);
    expect(
      ((await first.stream.result()) as CursorAssistantMessage).cursorUsage?.billing?.status,
    ).toBe("unavailable");
    const replacement = state();
    recordRunReceipt(replacement, bill, raw);
    const next = writer();
    next.writer.done("stop", replacement);
    expect((await next.stream.result()).usage.cost.total).toBeCloseTo(0.0022);
    expect(lost.runUsage?.reported).toBeUndefined();
  });
});
