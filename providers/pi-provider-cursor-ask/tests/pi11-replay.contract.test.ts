import { Type, type Context, type SystemMessage, type Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createCursorContextTracker,
  replayedSystemPrompt,
  replayedTools,
} from "../src/stream/context-usage.js";
import { contextToCursorChatCompletionRequest } from "../src/stream/pi-adapter.js";
import type { CursorNativeStreamConfig } from "../src/stream/types.js";

type Tracker = ReturnType<typeof createCursorContextTracker>;
type Output = Parameters<Tracker["finish"]>[0];
type Model = Parameters<typeof createCursorContextTracker>[0];

const model: Model = {
  id: "n5-synthetic-model",
  name: "N5 offline contract model",
  api: "cursor-native",
  provider: "cursor",
  baseUrl: "https://n5.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
};
const options = { sessionId: "n5-offline-session" };
const config: CursorNativeStreamConfig = {
  getAccessToken: () => {
    throw new Error("Pure request construction must not authenticate");
  },
};
const user = { role: "user", content: "Summarize the current rules.", timestamp: 2 } as const;
const nextUser = { role: "user", content: "Continue.", timestamp: 5 } as const;
const currentTool: Tool = {
  name: "lookup",
  description: "Look up a record by numeric ID",
  parameters: Type.Object({ recordId: Type.Integer() }, { additionalProperties: false }),
};
const oldTool: Tool = {
  name: "lookup",
  description: "Obsolete text search",
  parameters: Type.Object({ obsoleteQuery: Type.String() }),
};
const removedTool: Tool = {
  name: "retired",
  description: "Retired operation",
  parameters: Type.Object({ obsoletePath: Type.String() }),
};

function system(patch: Partial<Omit<SystemMessage, "role">>): SystemMessage {
  return { role: "system", content: "", timestamp: 1, ...patch };
}

function output(billedTokens = 0, selectedModel = model): Output {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
    api: selectedModel.api,
    provider: selectedModel.provider,
    model: selectedModel.id,
    timestamp: 4,
    stopReason: "stop",
    usage: {
      input: billedTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: billedTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function request(context: Context) {
  return contextToCursorChatCompletionRequest(model, context, options, config);
}

function estimate(context: Context, selectedModel = model, sessionId = options.sessionId) {
  const tracker = createCursorContextTracker(selectedModel, context, { sessionId });
  // Public usage semantics distinguish a live continuation from a full-history
  // rebuild, which deliberately discards compressed checkpoint anchors.
  tracker.begin("live");
  return tracker.finish(output(0, selectedModel));
}

function expectCurrentState(context: Context, prompt: string, tools: Tool[]) {
  const built = request(context);
  expect.soft(built.messages).toEqual([
    { role: "system", content: prompt },
    { role: "user", content: user.content },
  ]);
  expect.soft(built.tools ?? []).toEqual(
    tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })),
  );
  expect.soft(replayedSystemPrompt(context)).toBe(prompt);
  expect.soft(replayedTools(context)).toEqual(tools);

  // A materialized current configuration has the same request and estimation meaning.
  // No expected hash or estimator formula is duplicated here.
  const materialized: Context = {
    messages: [system({ content: prompt, toolsAdded: tools }), user],
  };
  const actual = estimate(context);
  const canonical = estimate(materialized);
  expect.soft(actual.source).toBe("estimate");
  expect.soft(actual.scope).toBe(canonical.scope);
  expect.soft(actual.tokens).toBe(canonical.tokens);
}

const observedTokens = 60_000;
function anchored(context: Context) {
  // Produce the anchor through the public lifecycle, never by inventing cursorUsage fields.
  const previous = output(900_000);
  const tracker = createCursorContextTracker(model, context, options);
  tracker.begin("history");
  tracker.observe(observedTokens, previous);
  const result = tracker.finish(previous);
  // Cursor's existing compatibility contract puts context, not the cumulative
  // bill, in totalTokens. Preserve the separate large billed input bucket.
  previous.usage.totalTokens = result.tokens;
  expect(result).toMatchObject({ source: "checkpoint", tokens: observedTokens });
  expect(previous.cursorUsage).toBeDefined();
  const continuation: Context = { messages: [...context.messages, previous, nextUser] };
  const reused = estimate(continuation);
  // Invalidation must not pass vacuously if the unchanged anchor was never usable.
  expect(reused.tokens, "unchanged anchor retains the observed context").toBeGreaterThanOrEqual(
    observedTokens,
  );
  expect(reused.tokens, "cumulative billing is not a context fallback").toBeLessThan(
    observedTokens + 1000,
  );
  return { previous, context: continuation };
}

const currentSystem = system({
  content: "Base.",
  sections: { rules: "<rules>Current.</rules>" },
  toolsAdded: [currentTool],
});
const currentContext: Context = { messages: [currentSystem, user] };

describe("Pi 1.1 effective replay at the Cursor request and tracker boundary", () => {
  it("positive control: builds the declared current state without authentication", () => {
    expectCurrentState(
      { messages: [system({ content: "Base.", toolsAdded: [currentTool] }), user] },
      "Base.",
      [currentTool],
    );
  });

  it.each([
    {
      name: "replaces a named section instead of retaining the old value",
      initial: { rules: "<rules>Obsolete.</rules>", keep: "<keep>Keep.</keep>" },
      update: { rules: "<rules>Current.</rules>" },
      expected: "Base.\n\n<rules>Current.</rules>\n\n<keep>Keep.</keep>",
    },
    {
      name: "deletes a null section without deleting its neighbors",
      initial: { rules: "<rules>Obsolete.</rules>", keep: "<keep>Keep.</keep>" },
      update: { rules: null },
      expected: "Base.\n\n<keep>Keep.</keep>",
    },
  ])("$name", ({ initial, update, expected }) => {
    expectCurrentState(
      {
        messages: [
          system({ content: "Base.", sections: initial }),
          user,
          system({ sections: update, timestamp: 3 }),
        ],
      },
      expected,
      [],
    );
  });

  it("appends later content while retaining current sections", () => {
    expectCurrentState(
      {
        messages: [
          system({ content: "Base.", sections: { rules: "<rules>Current.</rules>" } }),
          user,
          system({ content: [{ type: "text", text: "Additional instructions." }], timestamp: 3 }),
        ],
      },
      "Base.\n\nAdditional instructions.\n\n<rules>Current.</rules>",
      [],
    );
  });

  it.each([
    {
      name: "removes one tool and preserves the remaining definition",
      added: [currentTool, removedTool],
      patch: { toolsRemoved: [{ name: "retired" }] },
      expected: [currentTool],
    },
    {
      name: "redefines a tool with no stale schema properties",
      added: [oldTool],
      patch: { toolsAdded: [currentTool] },
      expected: [currentTool],
    },
    {
      name: "removes the last tool to produce an empty effective set",
      added: [currentTool],
      patch: { toolsRemoved: [{ name: "lookup" }] },
      expected: [],
    },
  ])("$name", ({ added, patch, expected }) => {
    expectCurrentState(
      {
        messages: [
          system({ content: "Base.", toolsAdded: added }),
          user,
          system({ ...patch, timestamp: 3 }),
        ],
      },
      "Base.",
      expected,
    );
  });

  it("ignores superseded prompt/schema history in requests, scope, estimates and anchor reuse", () => {
    const historical: Context = {
      messages: [
        system({
          content: "Base.",
          sections: { rules: "Retired rules. ".repeat(20), obsolete: "Remove me." },
          toolsAdded: [{ ...oldTool, description: "Retired schema. ".repeat(20) }, removedTool],
        }),
        user,
        system({
          sections: { rules: "<rules>Current.</rules>", obsolete: null },
          toolsRemoved: [{ name: "retired" }],
          toolsAdded: [currentTool],
          timestamp: 3,
        }),
      ],
    };
    expect.soft(request(historical).messages).toEqual(request(currentContext).messages);
    expect.soft(request(historical).tools).toEqual(request(currentContext).tools);
    const before = estimate(historical);
    const after = estimate(currentContext);
    expect.soft(before.scope).toBe(after.scope);
    expect.soft(before.tokens).toBe(after.tokens);

    const { previous, context: originalContinuation } = anchored(historical);
    const equivalentContinuation: Context = {
      messages: [...currentContext.messages, previous, nextUser],
    };
    const original = estimate(originalContinuation);
    const equivalent = estimate(equivalentContinuation);
    expect.soft(equivalent.scope).toBe(original.scope);
    expect.soft(equivalent.history).toBe(original.history);
    expect.soft(equivalent.tokens).toBe(original.tokens);
    expect.soft(equivalent.tokens).toBeGreaterThanOrEqual(observedTokens);
  });

  it("positive control: reuses an unchanged anchor rather than cumulative billing", () => {
    const { context } = anchored(currentContext);
    const result = estimate(context);
    expect(result.tokens).toBeGreaterThanOrEqual(observedTokens);
    expect(result.tokens).toBeLessThan(observedTokens + 1000);
  });

  it.each([
    { name: "effective system section", patch: { sections: { rules: "<rules>Changed.</rules>" } } },
    { name: "effective tool schema", patch: { toolsAdded: [oldTool] } },
  ])("invalidates an anchor after changing the $name", ({ patch }) => {
    const { context } = anchored(currentContext);
    const unchanged = estimate(context);
    const changed: Context = {
      messages: [...context.messages, system({ ...patch, timestamp: 6 })],
    };
    const result = estimate(changed);
    expect(result.scope).not.toBe(unchanged.scope);
    expect(result.source).toBe("estimate");
    expect(result.tokens).toBeLessThan(10_000);
  });

  it.each(["model", "session"] as const)("invalidates an anchor after a %s switch", (dimension) => {
    const { context } = anchored(currentContext);
    const unchanged = estimate(context);
    const result = estimate(
      context,
      dimension === "model" ? { ...model, id: "n5-other-synthetic-model" } : model,
      dimension === "session" ? "n5-other-session" : options.sessionId,
    );
    expect(result.scope).not.toBe(unchanged.scope);
    expect(result.source).toBe("estimate");
    expect(result.tokens).toBeLessThan(10_000);
  });

  it("invalidates a retained anchor when earlier history is compacted or rewritten", () => {
    const { previous, context } = anchored(currentContext);
    const unchanged = estimate(context);
    const compacted: Context = {
      messages: [
        currentSystem,
        { ...user, content: "Compacted summary replacing the original history." },
        previous,
        nextUser,
      ],
    };
    const result = estimate(compacted);
    expect(result.scope).toBe(unchanged.scope);
    expect(result.history).not.toBe(unchanged.history);
    expect(result.source).toBe("estimate");
    expect(result.tokens).toBeLessThan(10_000);
  });
});
