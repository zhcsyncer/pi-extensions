import { strict as assert } from "node:assert";
import { WorkingIndicatorState, isWorkingStalled, workingOutputTokens } from "../working-indicator-state.js";

const state = new WorkingIndicatorState();
state.agentStart(1_000, "Brewing", "high");
assert.equal(state.snapshot.active, true, "first agent_start should begin a cycle");
assert.equal(state.snapshot.phase, "requesting", "first agent_start should request");
assert.equal(state.snapshot.startedAtMs, 1_000, "first agent_start should establish the cycle clock");
assert.equal(state.snapshot.thinkingEffort, "high", "cycle should retain available thinking effort");

state.messageUpdate("thinking_delta", 42, 1_100);
assert.equal(state.snapshot.phase, "thinking", "thinking delta should project thinking phase");
assert.equal(workingOutputTokens(state.snapshot), 42, "partial thinking should contribute an estimate");
assert.equal(state.snapshot.hasPartialEstimate, true, "partial estimate should be visibly marked");

state.messageUpdate("toolcall_delta", 55, 1_200);
assert.equal(state.snapshot.phase, "thinking", "tool-call assembly should keep the current generation phase");
assert.equal(workingOutputTokens(state.snapshot), 55, "complete partial re-estimation should replace rather than add deltas");

state.messageEnd({ role: "assistant", responseId: "response-1", usage: { output: 50 } }, 1_300);
assert.equal(workingOutputTokens(state.snapshot), 50, "final provider output should replace the partial estimate without double counting");
assert.equal(state.snapshot.hasPartialEstimate, false, "finalized output should remove the estimate marker");
state.messageEnd({ role: "assistant", responseId: "response-1", usage: { output: 999 } }, 1_400);
assert.equal(workingOutputTokens(state.snapshot), 50, "responseId should dedupe repeated finalized usage");

state.agentStart(2_000, "Different", "medium");
assert.equal(state.snapshot.verb, "Brewing", "retry before settled should preserve the cycle verb");
assert.equal(state.snapshot.startedAtMs, 1_000, "retry before settled should preserve elapsed origin");
assert.equal(workingOutputTokens(state.snapshot), 50, "retry before settled should preserve accumulated output");
assert.equal(state.snapshot.phase, "requesting", "retry should return to requesting");

state.messageUpdate("text_delta", 7, 2_100);
state.messageEnd({ role: "assistant", responseId: "response-2", usage: { output: 8 } }, 2_200);
assert.equal(workingOutputTokens(state.snapshot), 58, "multiple assistant turns should accumulate finalized cycle output");

state.toolExecutionStart("tool-a", "bash\nunsafe", 2_300);
state.toolExecutionStart("tool-b", "read", 2_301);
assert.equal(state.snapshot.phase, "tool-use", "tool start should enter tool-use");
assert.deepEqual(state.snapshot.tools.map((tool) => tool.name), ["bashunsafe", "read"], "tools should be tracked by id with control-free names");
state.toolExecutionEnd("tool-a", 2_400);
assert.equal(state.snapshot.phase, "tool-use", "remaining parallel tools should keep tool-use");
assert.equal(state.snapshot.tools.length, 1, "tool end should remove only its matching toolCallId");
state.toolExecutionEnd("tool-b", 2_500);
assert.equal(state.snapshot.phase, "requesting", "last tool end should return to requesting");

state.messageUpdate("text_delta", 3, 3_000);
assert.equal(isWorkingStalled(state.snapshot, 12_999), false, "responding should not stall before ten seconds");
assert.equal(isWorkingStalled(state.snapshot, 13_000), true, "responding with prior progress should stall after ten seconds without progress");
state.messageUpdate("text_delta", 4, 13_001);
assert.equal(isWorkingStalled(state.snapshot, 13_001), false, "new assistant progress should immediately clear stall");
state.turnStart(13_002);
state.messageUpdate("text_start", 4, 13_003);
assert.equal(isWorkingStalled(state.snapshot, 99_999), false, "a new responding phase should require its own generation delta before stall is possible");
state.messageUpdate("text_delta", 5, 100_000);
assert.equal(isWorkingStalled(state.snapshot, 110_000), true, "the new responding phase should become stall-eligible after its own delta");
state.toolExecutionStart("tool-c", "bash", 110_001);
assert.equal(isWorkingStalled(state.snapshot, 99_999), false, "tool-use should never be marked stalled");

// agent_end intentionally has no state transition; settled is the cycle boundary.
assert.equal(state.snapshot.active, true, "agent_end-equivalent inactivity should retain the cycle until settled");
state.settle();
assert.equal(state.snapshot.active, false, "agent_settled should clear the cycle");
assert.equal(state.snapshot.phase, "idle", "agent_settled should return to idle");
assert.equal(workingOutputTokens(state.snapshot), 0, "agent_settled should clear output accounting");

console.log("✓ working indicator state checks passed");
