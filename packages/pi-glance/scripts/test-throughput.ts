import { strict as assert } from "node:assert";
import { calculateTurnThroughput } from "../throughput.js";

function assistant(usage?: Record<string, unknown>, stopReason = "stop"): unknown {
	return { role: "assistant", stopReason, usage };
}

const timing = { startedAtMs: 1_000, endedAtMs: 35_000, inferenceMs: 2_500 };
assert.deepEqual(
	calculateTurnThroughput({ ...timing, messages: [assistant({ output: 50 })] }),
	{
		startedAtMs: 1_000,
		endedAtMs: 35_000,
		elapsedMs: 2_500,
		tokensPerSecond: 20,
		usage: { input: 0, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 50, assistantMessages: 1 },
	},
	"denominator is explicit inference time, not the run's wall time including waiting and tools",
);
assert.equal(
	calculateTurnThroughput({ ...timing, inferenceMs: 10_000, messages: [assistant({ output: 50 })] })?.tokensPerSecond,
	5,
	"longer inference (including thinking) lowers speed for the same usage.output",
);

assert.deepEqual(
	calculateTurnThroughput({
		...timing,
		messages: [
			{ role: "user", usage: { output: 999 } },
			{ role: "toolResult", usage: { output: 999 } },
			assistant({ input: 10, output: 20, cacheRead: 3, cacheWrite: 4, totalTokens: 37 }),
			assistant({ input: 5, output: 30, cacheRead: 7, cacheWrite: 8 }),
		],
	})?.usage,
	{ input: 15, output: 50, cacheRead: 10, cacheWrite: 12, totalTokens: 87, assistantMessages: 2 },
	"aggregate only assistant usage, never nested tool usage",
);

for (const inferenceMs of [0, -1, NaN, Infinity, 34_001]) {
	assert.equal(calculateTurnThroughput({ ...timing, inferenceMs, messages: [assistant({ output: 50 })] }), undefined,
		`invalid inference time ${inferenceMs} must not fall back to wall time`);
}
for (const endedAtMs of [1_000, 0, Infinity, NaN]) {
	assert.equal(calculateTurnThroughput({ ...timing, endedAtMs, messages: [assistant({ output: 50 })] }), undefined,
		"invalid run bounds should not produce a measurement");
}
for (const messages of [
	[],
	[{ role: "user", usage: { output: 50 } }],
	[assistant()],
	[assistant({ input: 10, output: 0 })],
	[{ role: "assistant", content: "visible text is not a usage fallback" }],
	[assistant({ output: 20 }), assistant({ output: 20 }, "error")],
	[assistant({ output: 20 }), assistant({ output: 20 }, "aborted")],
]) {
	assert.equal(calculateTurnThroughput({ ...timing, messages }), undefined, "missing output or invalid final assistant should stay unknown");
}

assert.deepEqual(
	calculateTurnThroughput({
		...timing,
		messages: [
			assistant({ input: -10, output: NaN, cacheRead: -Infinity, cacheWrite: -5, totalTokens: Infinity }),
			assistant({ input: 2.9, output: 20.4, cacheRead: 3.5, cacheWrite: 4.1 }),
		],
	})?.usage,
	{ input: 2.9, output: 20.4, cacheRead: 3.5, cacheWrite: 4.1, totalTokens: 30.9, assistantMessages: 2 },
	"normalize invalid usage to zero while preserving finite non-negative fractions",
);

const originalDateNow = Date.now;
try {
	Date.now = () => { throw new Error("calculation must use injected timing"); };
	assert.equal(calculateTurnThroughput({ ...timing, messages: [assistant({ output: 50 })] })?.tokensPerSecond, 20);
} finally {
	Date.now = originalDateNow;
}

console.log("✓ throughput pure calculation checks passed");
