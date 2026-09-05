import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type Api,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createCursorContextTracker,
  estimateMessageTokens,
  type CursorAssistantMessage,
} from "../src/stream/context-usage.js";
import { createCursorAssistantMessage } from "../src/stream/pi-adapter.js";
import { createNativeStreamWriter } from "../src/stream/stream-writer.js";

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
const user = { role: "user" as const, content: "inspect the fixture", timestamp: 1 };
const context: Context = { systemPrompt: "Follow the user's request", messages: [user] };
const options = { sessionId: "session-a", reasoning: "off" };

function anchoredMessage(): CursorAssistantMessage {
  const output = createCursorAssistantMessage(model);
  output.content = [{ type: "text", text: "ready" }];
  const tracker = createCursorContextTracker(model, context, options);
  tracker.observe(80_000, output);
  tracker.finish(output);
  return output;
}

describe("Cursor context independent of billing", () => {
  it("uses a positive local estimate when a huge bill arrives without a snapshot", async () => {
    const stream = createAssistantMessageEventStream();
    const writer = createNativeStreamWriter(stream, model, context, options);
    writer.text("done");
    writer.done("stop", {
      toolCallIndex: 0,
      pendingExecs: [],
      outputTokens: 1656,
      totalTokens: 0,
      turnEnded: true,
      billedUsage: { input: 600_000, output: 238, cacheRead: 550_000, cacheWrite: 0 },
    });
    const output = (await stream.result()) as CursorAssistantMessage;
    expect(output.usage.totalTokens).toBeGreaterThan(0);
    expect(output.usage.totalTokens).toBeLessThan(1000);
    expect(output.usage.cacheRead).toBe(550_000);
    expect(output.cursorUsage?.context.source).toBe("estimate");
  });

  it("keeps a real snapshot even when it exceeds the model window", () => {
    const output = createCursorAssistantMessage(model);
    const tracker = createCursorContextTracker(model, context, options);
    tracker.observe(220_000, output);
    tracker.observe(0, output);
    expect(tracker.finish(output)).toMatchObject({ tokens: 220_000, source: "checkpoint" });
    tracker.observe(70_000, output);
    expect(tracker.finish(output).tokens).toBe(70_000);
  });

  it("adds only output generated after the last snapshot", () => {
    const output = createCursorAssistantMessage(model);
    const tracker = createCursorContextTracker(model, context, options);
    output.content = [{ type: "text", text: "already included" }];
    tracker.observe(80_000, output);
    const before = estimateMessageTokens(output);
    output.content.push({ type: "thinking", thinking: "generated after checkpoint" });
    expect(tracker.finish(output)).toMatchObject({
      tokens: 80_000 + estimateMessageTokens(output) - before,
      source: "estimate",
    });
  });

  it("preserves a validated context anchor across tool-result continuation", () => {
    const previous = anchoredMessage();
    const tool = {
      role: "toolResult" as const,
      toolCallId: "tool-1",
      toolName: "read",
      isError: false,
      content: [{ type: "text" as const, text: "fixture data" }],
      timestamp: 2,
    };
    const output = createCursorAssistantMessage(model);
    const tracker = createCursorContextTracker(
      model,
      { ...context, messages: [user, previous, tool] },
      options,
    );
    expect(tracker.finish(output).tokens).toBe(
      80_000 + estimateMessageTokens(tool) + estimateMessageTokens(output),
    );
  });

  it.each(["session", "model", "thinking", "system", "tools", "compaction", "history"])(
    "invalidates a previous anchor after a %s change",
    (change) => {
      const previous = anchoredMessage();
      const nextContext: Context = { ...context, messages: [user, previous] };
      const nextModel = { ...model };
      const nextOptions = { ...options };
      if (change === "session") nextOptions.sessionId = "forked-session";
      if (change === "model") nextModel.id = "composer-2.5-fast";
      if (change === "thinking") nextOptions.reasoning = "max";
      if (change === "system") nextContext.systemPrompt = "new system prompt";
      if (change === "tools")
        nextContext.tools = [{ name: "read", description: "changed", parameters: {} as never }];
      if (change === "compaction") nextContext.messages = [previous];
      if (change === "history")
        nextContext.messages = [{ ...user, content: "edited history" }, previous];
      const tracker = createCursorContextTracker(nextModel, nextContext, nextOptions);
      expect(tracker.finish(createCursorAssistantMessage(nextModel)).tokens).toBeLessThan(1000);
    },
  );

  it("keeps a real aborted-response anchor only on checkpoint recovery", () => {
    const previous = anchoredMessage();
    previous.stopReason = "aborted";
    const nextContext = { ...context, messages: [user, previous] };
    const tracker = createCursorContextTracker(model, nextContext, options);
    tracker.begin("checkpoint", 80_000);
    expect(tracker.finish(createCursorAssistantMessage(model)).tokens).toBeGreaterThanOrEqual(
      80_000,
    );
    tracker.begin("history");
    expect(tracker.finish(createCursorAssistantMessage(model)).tokens).toBeLessThan(1000);
  });

  it("does not reuse an upstream summary size after expanding the full history", () => {
    const largeContext: Context = {
      ...context,
      messages: [{ ...user, content: "long history ".repeat(40_000) }],
    };
    const previous = createCursorAssistantMessage(model);
    const first = createCursorContextTracker(model, largeContext, options);
    first.observe(1000, previous);
    first.finish(previous);
    const tracker = createCursorContextTracker(
      model,
      { ...largeContext, messages: [...largeContext.messages, previous] },
      options,
    );
    tracker.begin("checkpoint", 1000);
    expect(tracker.finish(createCursorAssistantMessage(model)).tokens).toBeLessThan(2000);
    tracker.begin("history");
    expect(tracker.finish(createCursorAssistantMessage(model)).tokens).toBeGreaterThan(100_000);
  });

  it("lets a newer inherited snapshot shrink an older larger anchor", () => {
    const previous = anchoredMessage();
    const nextContext = { ...context, messages: [user, previous] };
    const tracker = createCursorContextTracker(model, nextContext, options);
    tracker.begin("live", 20_000);
    expect(tracker.finish(createCursorAssistantMessage(model)).tokens).toBeLessThan(21_000);
    tracker.begin("checkpoint", 10_000);
    expect(tracker.finish(createCursorAssistantMessage(model)).tokens).toBeLessThan(11_000);
  });

  it("does not trust unmarked legacy usage as a context anchor", () => {
    const previous = createCursorAssistantMessage(model);
    previous.usage.totalTokens = 600_000;
    const tracker = createCursorContextTracker(
      model,
      { ...context, messages: [user, previous] },
      options,
    );
    expect(tracker.finish(createCursorAssistantMessage(model)).tokens).toBeLessThan(1000);
  });

  it("does not tokenize image base64 as text", () => {
    const image = (n: number) => ({
      content: [{ type: "image" as const, data: "a".repeat(n), mimeType: "image/png" }],
    });
    expect(estimateMessageTokens(image(4))).toBe(estimateMessageTokens(image(40_000)));
  });
});
