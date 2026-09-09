import { strict as assert } from "node:assert";
import { ThroughputRunTracker, type ThroughputRunStateIntent } from "../throughput-run-tracker.js";

const clock = (value: number) => () => value;
const noClock = () => { throw new Error("inactive or duplicate event must not read clock"); };
const assistant = (output: number, stopReason = "stop") => ({ role: "assistant", usage: { output }, stopReason });
function measurement(intent: ThroughputRunStateIntent) {
	if (intent.kind === "set-current-run") return intent.currentRun;
	if (intent.kind === "set-last-turn-and-clear-current-run") return intent.lastTurn;
	assert.fail(`expected a measurement, got ${intent.kind}`);
}

{
	const run = new ThroughputRunTracker();
	run.messageUpdate("text_delta", noClock);
	run.toolExecutionStart("inactive", noClock);
	assert.deepEqual(run.checkpoint(0, assistant(50), noClock), { kind: "none" });
	assert.deepEqual(run.finish([assistant(50)], noClock), { kind: "clear-current-run" });
	assert.deepEqual(run.settle(noClock), { kind: "none" });
}

{
	const run = new ThroughputRunTracker();
	assert.deepEqual(run.start(0), { kind: "clear-current-run" });
	for (const type of ["start", "thinking_start", "text_start", "toolcall_start", "thinking_end", "text_end"]) {
		run.messageUpdate(type, noClock);
	}
	assert.deepEqual(run.finish([assistant(50)], clock(20_000)), { kind: "clear-current-run" },
		"without a delta, pure waiting never becomes a speed sample");
}

{
	const run = new ThroughputRunTracker();
	run.start(0);
	run.messageUpdate("thinking_delta", clock(5_000));
	run.messageUpdate("thinking_delta", noClock);
	run.messageUpdate("thinking_end", noClock);
	run.messageUpdate("text_start", noClock);
	run.messageUpdate("text_delta", noClock);
	run.messageEnd(clock(15_000));
	const result = measurement(run.finish([assistant(50)], clock(18_000)));
	assert.equal(result.elapsedMs, 10_000, "thinking and writing are one continuous interval; initial and final waiting excluded");
	assert.equal(result.tokensPerSecond, 5, "thinking lowers visible-output speed rather than stopping the clock");
	assert.equal(result.startedAtMs, 0);
	assert.equal(result.endedAtMs, 18_000);
}

{
	const run = new ThroughputRunTracker();
	run.start(0);
	run.messageUpdate("toolcall_delta", clock(1_000));
	run.toolExecutionStart("a", clock(3_000));
	run.toolExecutionStart("a", noClock);
	run.toolExecutionStart("b", noClock);
	run.messageUpdate("thinking_delta", noClock);
	run.toolExecutionEnd("unknown");
	run.toolExecutionEnd("a");
	run.toolExecutionEnd("a");
	run.messageUpdate("text_delta", noClock);
	run.toolExecutionEnd("b"); // 31s: tool execution lasted 28 seconds
	const partial = measurement(run.checkpoint(0, assistant(20), clock(31_000)));
	assert.equal(partial.elapsedMs, 2_000, "overlapping tools exclude the union of their execution intervals");
	assert.equal(partial.tokensPerSecond, 10);
	run.messageUpdate("thinking_start", noClock);
	run.messageUpdate("thinking_delta", clock(35_000));
	run.messageUpdate("text_delta", noClock);
	run.messageUpdate("done", clock(38_000));
	const result = measurement(run.finish([assistant(20), assistant(80)], clock(40_000)));
	assert.equal(result.elapsedMs, 5_000, "exclude 28s tools and post-tool request waiting, include resumed thinking");
	assert.equal(result.tokensPerSecond, 20);
	assert.equal(result.usage.assistantMessages, 2);
}

{
	const run = new ThroughputRunTracker();
	run.start(0);
	run.messageUpdate("text_delta", clock(1_000));
	run.uiPromptStart(clock(2_000));
	run.uiPromptStart(noClock); // Pi coalesces nested prompts
	run.messageUpdate("text_delta", noClock);
	run.toolExecutionStart("question", noClock);
	run.uiPromptEnd();
	run.messageUpdate("thinking_delta", noClock);
	run.toolExecutionEnd("question");
	run.messageUpdate("text_delta", clock(30_000));
	run.messageEnd(clock(31_000));
	assert.equal(measurement(run.finish([assistant(40)], clock(32_000))).elapsedMs, 2_000,
		"UI end cannot restart timing while a tool is still in flight");
}

{
	const run = new ThroughputRunTracker();
	run.start(0);
	run.messageUpdate("text_delta", clock(1_000));
	run.uiPromptStart(clock(2_000));
	run.toolExecutionStart("question", noClock);
	run.toolExecutionEnd("question");
	run.messageUpdate("text_delta", noClock);
	run.uiPromptEnd();
	run.messageUpdate("text_delta", clock(20_000));
	assert.equal(measurement(run.finish([assistant(40)], clock(21_000))).tokensPerSecond, 20,
		"tool end cannot restart timing while UI remains blocked");
}

{
	const run = new ThroughputRunTracker();
	run.start(0);
	run.messageUpdate("text_delta", clock(1_000));
	assert.deepEqual(run.checkpoint(7, { role: "user" }, noClock), { kind: "none" });
	assert.equal(measurement(run.checkpoint(7, assistant(20), clock(2_000))).tokensPerSecond, 20);
	assert.deepEqual(run.checkpoint(7, assistant(999), noClock), { kind: "none" });
	run.messageUpdate("text_delta", clock(5_000));
	const current = run.checkpoint(8, assistant(60), clock(8_000));
	assert.equal(current.kind, "set-current-run");
	assert.equal(measurement(current).tokensPerSecond, 20, "checkpoints sum only completed assistant output and inference spans");
	const final = run.finish([assistant(100)], clock(10_000));
	assert.equal(final.kind, "set-last-turn-and-clear-current-run");
	assert.equal(measurement(final).tokensPerSecond, 25, "final usage comes from agent_end, not checkpoints");
	assert.deepEqual(run.settle(noClock), { kind: "none" }, "settled after end must not replace the final");
	assert.deepEqual(run.finish([assistant(1)], noClock), { kind: "clear-current-run" });
}

{
	const run = new ThroughputRunTracker();
	run.start(0);
	run.messageUpdate("text_delta", clock(1_000));
	assert.deepEqual(run.checkpoint(undefined, assistant(0), clock(2_000)), { kind: "clear-current-run" });
	run.messageUpdate("text_delta", clock(3_000));
	const current = measurement(run.checkpoint(undefined, assistant(40), clock(4_000)));
	assert.equal(current.usage.assistantMessages, 2, "undefined indexes are not deduplicated and zero-output checkpoints still accumulate");
	assert.equal(current.tokensPerSecond, 20);
	const final = run.settle(clock(8_000));
	assert.equal(final.kind, "set-last-turn-and-clear-current-run");
	assert.equal(measurement(final).elapsedMs, 2_000, "settled can finalize checkpoints without counting post-checkpoint waiting");
}

for (const messages of [[assistant(0)], [assistant(20, "error")], [assistant(20, "aborted")], {}]) {
	const run = new ThroughputRunTracker();
	run.start(0);
	run.messageUpdate("text_delta", clock(1_000));
	run.checkpoint(0, assistant(20), clock(2_000));
	assert.deepEqual(run.finish(messages, clock(3_000)), { kind: "clear-current-run" }, "invalid finals preserve lastTurn by intent");
	assert.deepEqual(run.checkpoint(1, assistant(20), noClock), { kind: "none" }, "invalid final resets lifecycle");
}

for (const reset of ["start", "reset"] as const) {
	const run = new ThroughputRunTracker();
	run.start(0);
	run.messageUpdate("thinking_delta", clock(1_000));
	run.toolExecutionStart("stale", clock(2_000));
	run.uiPromptStart(noClock);
	if (reset === "reset") {
		run.reset();
		assert.deepEqual(run.checkpoint(0, assistant(20), noClock), { kind: "none" });
	}
	run.start(10_000);
	run.messageUpdate("text_delta", clock(11_000));
	assert.equal(measurement(run.finish([assistant(20)], clock(12_000))).tokensPerSecond, 20,
		"a fresh run clears old timing, tool and UI blockers");
}

console.log("✓ throughput run tracker checks passed");
