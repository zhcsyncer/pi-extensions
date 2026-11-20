import { expect, it } from "vitest";
import { NestedAgentSettlement } from "../src/nested-agent-settlement.js";

const start = (fence: NestedAgentSettlement, toolCallId: string, toolName: string, parentToolCallId?: string) =>
  fence.start({ toolCallId, toolName, parentToolCallId });

it("waits only for the specified root, not unrelated Agent calls or get-result waiters", async () => {
  const fence = new NestedAgentSettlement("Agent");
  start(fence, "root-a", "codemode");
  start(fence, "root-b", "codemode");
  start(fence, "agent-a", "Agent", "root-a");
  start(fence, "waiter-b", "get_subagent_result", "root-b");
  let done = false;
  const a = fence.waitForRoot({ toolCallId: "root-a" }).then(() => { done = true; });
  await fence.waitForRoot({ toolCallId: "root-b" });
  expect(done).toBe(false);
  fence.end("agent-a"); await a;
  expect(done).toBe(true);
});

it("follows the actual parent chain through ended intermediate tools, without parsing IDs", async () => {
  const fence = new NestedAgentSettlement("Agent");
  start(fence, "root", "codemode");
  start(fence, "independent-middle-id", "bridge", "root");
  start(fence, "another-middle", "bridge", "independent-middle-id");
  fence.end("independent-middle-id");
  start(fence, "leaf", "Agent", "another-middle");
  fence.end("another-middle");
  let done = false;
  const wait = fence.waitForRoot({ toolCallId: "root" }).then(() => { done = true; });
  await fence.waitForRoot({ toolCallId: "another-middle", parentToolCallId: "independent-middle-id" });
  expect(done).toBe(false);
  fence.end("leaf"); await wait;
  expect(done).toBe(true);
});

it("does not release active nested calls merely because the outer execution ended", async () => {
  const fence = new NestedAgentSettlement("Agent");
  start(fence, "root", "codemode");
  start(fence, "child", "Agent", "root");
  fence.end("root");
  let done = false;
  const wait = fence.waitForRoot({ toolCallId: "root" }).then(() => { done = true; });
  await Promise.resolve();
  expect(done).toBe(false);
  fence.end("child"); await wait;
  expect(done).toBe(true);
  // Reusing IDs after all real end events must not inherit stale promises.
  start(fence, "root", "codemode");
  await fence.waitForRoot({ toolCallId: "root" });
});

it("waits for an additional Agent that starts while an earlier Agent settles", async () => {
  const fence = new NestedAgentSettlement("Agent");
  start(fence, "root", "codemode");
  start(fence, "first", "Agent", "root");
  let done = false;
  const wait = fence.waitForRoot({ toolCallId: "root" }).then(() => { done = true; });
  start(fence, "second", "Agent", "root");
  fence.end("first");
  await Promise.resolve();
  expect(done).toBe(false);
  fence.end("second"); await wait;
  expect(done).toBe(true);
});

it("does not wait for direct Agent itself or the child of a returned background launch", async () => {
  const fence = new NestedAgentSettlement("Agent");
  start(fence, "direct", "Agent");
  await fence.waitForRoot({ toolCallId: "direct" });
  fence.end("direct");
  start(fence, "root", "codemode");
  start(fence, "background-launch", "Agent", "root");
  fence.end("background-launch");
  await fence.waitForRoot({ toolCallId: "root" });
});

it("keeps activations independent even when their tool call IDs match", async () => {
  const old = new NestedAgentSettlement("Agent"), fresh = new NestedAgentSettlement("Agent");
  start(old, "root", "codemode"); start(old, "agent", "Agent", "root");
  start(fresh, "root", "codemode");
  await fresh.waitForRoot({ toolCallId: "root" });
  let done = false;
  const wait = old.waitForRoot({ toolCallId: "root" }).then(() => { done = true; });
  fresh.end("root");
  await Promise.resolve(); expect(done).toBe(false);
  old.end("agent"); await wait;
});
