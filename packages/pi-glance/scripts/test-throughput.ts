import { strict as assert } from "node:assert";

interface ThroughputUsageExpectation {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	assistantMessages: number;
}

interface TurnThroughputExpectation {
	startedAtMs: number;
	endedAtMs: number;
	elapsedMs: number;
	tokensPerSecond: number;
	usage: ThroughputUsageExpectation;
}

type CalculateTurnThroughput = (input: {
	startedAtMs: number;
	endedAtMs: number;
	messages: readonly unknown[];
}) => unknown;

const modulePath = "../throughput.js";
let throughputModule: Record<string, unknown>;
try {
	throughputModule = (await import(modulePath)) as Record<string, unknown>;
} catch (error) {
	assert.fail(`throughput.ts should exist as a pure calculation module exporting calculateTurnThroughput; import failed: ${(error as Error).message}`);
}

assert.equal(
	typeof throughputModule.calculateTurnThroughput,
	"function",
	"throughput.ts should export calculateTurnThroughput({ startedAtMs, endedAtMs, messages })",
);

const calculateTurnThroughput = throughputModule.calculateTurnThroughput as CalculateTurnThroughput;

function assistant(usage?: Record<string, unknown>, stopReason = "stop"): unknown {
	return { role: "assistant", stopReason, usage };
}

function user(usage?: Record<string, unknown>): unknown {
	return { role: "user", usage };
}

function tool(usage?: Record<string, unknown>): unknown {
	return { role: "tool", usage };
}

function expectTurn(actual: unknown, expected: TurnThroughputExpectation, message: string): void {
	assert.deepEqual(
		actual,
		expected,
		message,
	);
}

function expectUndefined(input: Parameters<CalculateTurnThroughput>[0], message: string): void {
	assert.equal(calculateTurnThroughput(input), undefined, message);
}

expectTurn(
	calculateTurnThroughput({
		startedAtMs: 1_000,
		endedAtMs: 3_500,
		messages: [assistant({ output: 50 })],
	}),
	{
		startedAtMs: 1_000,
		endedAtMs: 3_500,
		elapsedMs: 2_500,
		tokensPerSecond: 20,
		usage: {
			input: 0,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 50,
			assistantMessages: 1,
		},
	},
	"2500ms elapsed with 50 assistant output tokens should calculate 20 tok/s",
);

expectTurn(
	calculateTurnThroughput({
		startedAtMs: 0,
		endedAtMs: 2_500,
		messages: [
			assistant({ input: 10, output: 20, cacheRead: 3, cacheWrite: 4, totalTokens: 37 }),
			assistant({ input: 5, output: 30, cacheRead: 7, cacheWrite: 8, totalTokens: 50 }),
		],
	}),
	{
		startedAtMs: 0,
		endedAtMs: 2_500,
		elapsedMs: 2_500,
		tokensPerSecond: 20,
		usage: {
			input: 15,
			output: 50,
			cacheRead: 10,
			cacheWrite: 12,
			totalTokens: 87,
			assistantMessages: 2,
		},
	},
	"multiple assistant messages in one agent_end should aggregate usage before calculating tok/s",
);

expectTurn(
	calculateTurnThroughput({
		startedAtMs: 0,
		endedAtMs: 1_000,
		messages: [
			user({ input: 999, output: 999, totalTokens: 1_998 }),
			tool({ input: 999, output: 999, totalTokens: 1_998 }),
			assistant({ input: 1, output: 20, totalTokens: 21 }),
		],
	}),
	{
		startedAtMs: 0,
		endedAtMs: 1_000,
		elapsedMs: 1_000,
		tokensPerSecond: 20,
		usage: {
			input: 1,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 21,
			assistantMessages: 1,
		},
	},
	"throughput usage should ignore non-assistant messages entirely",
);

for (const [input, message] of [
	[
		{ startedAtMs: 0, endedAtMs: 1_000, messages: [assistant()] },
		"assistant messages with missing usage should be invalid instead of falling back to content length",
	],
	[
		{ startedAtMs: 0, endedAtMs: 1_000, messages: [assistant({ input: 10, output: 0, totalTokens: 10 })] },
		"assistant output=0 should be invalid and hide the segment",
	],
	[
		{ startedAtMs: 0, endedAtMs: 1_000, messages: [user({ output: 50 })] },
		"agent_end with no assistant messages should be invalid",
	],
	[
		{ startedAtMs: 1_000, endedAtMs: 1_000, messages: [assistant({ output: 50 })] },
		"elapsedMs=0 should be invalid",
	],
	[
		{ startedAtMs: 2_000, endedAtMs: 1_000, messages: [assistant({ output: 50 })] },
		"negative elapsedMs should be invalid",
	],
] as const) {
	expectUndefined(input, message);
}

expectTurn(
	calculateTurnThroughput({
		startedAtMs: 0,
		endedAtMs: 1_000,
		messages: [
			assistant({
				input: -10,
				output: Number.NaN,
				cacheRead: Number.NEGATIVE_INFINITY,
				cacheWrite: -5,
				totalTokens: Number.POSITIVE_INFINITY,
			}),
			assistant({ input: 2.9, output: 20.4, cacheRead: 3.5, cacheWrite: 4.1 }),
		],
	}),
	{
		startedAtMs: 0,
		endedAtMs: 1_000,
		elapsedMs: 1_000,
		tokensPerSecond: 20.4,
		usage: {
			input: 2.9,
			output: 20.4,
			cacheRead: 3.5,
			cacheWrite: 4.1,
			totalTokens: 30.9,
			assistantMessages: 2,
		},
	},
	"non-finite and negative usage values should normalize to zero while finite non-negative values are preserved",
);

for (const stopReason of ["error", "aborted"] as const) {
	expectUndefined(
		{
			startedAtMs: 0,
			endedAtMs: 1_000,
			messages: [assistant({ output: 20 }, "stop"), assistant({ output: 20 }, stopReason)],
		},
		`last assistant stopReason=${stopReason} should invalidate this turn instead of showing stale/partial throughput`,
	);
}

const originalDateNow = Date.now;
try {
	Date.now = () => {
		throw new Error("calculateTurnThroughput must use injected startedAtMs/endedAtMs, not Date.now()");
	};
	expectTurn(
		calculateTurnThroughput({
			startedAtMs: 10,
			endedAtMs: 2_010,
			messages: [assistant({ output: 40, totalTokens: 40, content: "do not tokenize this" })],
		}),
		{
			startedAtMs: 10,
			endedAtMs: 2_010,
			elapsedMs: 2_000,
			tokensPerSecond: 20,
			usage: {
				input: 0,
				output: 40,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 40,
				assistantMessages: 1,
			},
		},
		"pure throughput calculation should not call Date.now and should not tokenize/content-length fallback",
	);
} finally {
	Date.now = originalDateNow;
}

expectUndefined(
	{
		startedAtMs: 0,
		endedAtMs: 1_000,
		messages: [{ role: "assistant", content: "fifty visible characters but no usage output" }],
	},
	"assistant content without usage.output should stay invalid; no content-length token fallback",
);

console.log("✓ throughput pure calculation checks passed");
