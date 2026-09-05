import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import {
	ContextGrowthLedger,
	formatContextGrowth,
	reportedContextInput,
	type ContextGrowth,
} from "../src/context-growth.ts";

// Black-box fixtures: no dependency on ledger internals or aggregate rendering.
function usage(input = 1_000, output = 50, cacheRead = 0, cacheWrite = 0) {
	return {
		input, output, cacheRead, cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(overrides: Record<string, unknown> = {}) {
	return {
		role: "assistant",
		provider: "openai",
		api: "openai-responses",
		model: "fixture-model",
		content: [{ type: "text", text: "abcdefgh" }],
		usage: usage(),
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

function toolCall(id: string, name = "read") {
	return { type: "toolCall", id, name, arguments: {} };
}

function result(toolCallId: string, text = "abcdefgh", overrides: Record<string, unknown> = {}) {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
		...overrides,
	};
}

function contentEstimate(message: unknown) {
	return estimateTokens(message as Parameters<typeof estimateTokens>[0]);
}

function assertUnavailable(growth: ContextGrowth | undefined) {
	assert.ok(growth !== undefined && growth.tokens === undefined,
		`expected explicit unavailable growth, received ${JSON.stringify(growth)}`);
}

function recordToolTurn(ledger: ContextGrowthLedger) {
	ledger.recordAssistant("run", "A", assistant({
		usage: usage(1_000, 50, 9_000, 500),
		stopReason: "toolUse",
		content: [toolCall("read-a"), toolCall("bash-a", "bash")],
	}));
}

function recordOwnResults(ledger: ContextGrowthLedger) {
	// Eight and twelve text characters contribute 2 and 3 estimated tokens.
	ledger.recordToolResult(result("read-a", "abcdefgh", {
		usage: usage(90_000_000, 80_000_000, 70_000_000, 60_000_000),
		details: { usage: usage(50_000_000), payload: "x".repeat(4_000) },
	}));
	ledger.recordToolResult(result("bash-a", "abcdefghijkl", { toolName: "bash" }));
}

function replayCompletedRun(ledger: ContextGrowthLedger) {
	recordToolTurn(ledger);
	recordOwnResults(ledger);
	ledger.recordAssistant("run", "B", assistant({ usage: usage(1_300, 80, 11_000, 0) }));
}

test("reported input sums input, cache reads and cache writes only", () => {
	const message = assistant({ usage: {
		...usage(1_000, 800_000, 9_000, 500),
		totalTokens: 9_000_000,
		cacheWrite1h: 400,
		reasoning: 700_000,
	} });
	assert.equal(reportedContextInput(message), 10_500);
});

for (const [label, cacheRead, cacheWrite] of [
	["read cache", 9_000, 0],
	["write cache", 0, 500],
] as const) {
	test(`reported input accepts zero uncached input with ${label}`, () => {
		assert.equal(reportedContextInput(assistant({ usage: usage(0, 50, cacheRead, cacheWrite) })),
			cacheRead + cacheWrite);
	});
}

const invalidComponents = [
	["missing", undefined], ["null", null], ["negative", -1],
	["NaN", NaN], ["infinite", Infinity], ["numeric string", "1000"],
] as const;

for (const component of ["input", "cacheRead", "cacheWrite"] as const) {
	for (const [label, value] of invalidComponents) {
		test(`reported input rejects ${label} ${component}`, () => {
			assert.equal(reportedContextInput(assistant({ usage: { ...usage(), [component]: value } })), undefined);
		});
	}
}

for (const [label, message] of [
	["absent message", undefined],
	["null message", null],
	["absent usage", assistant({ usage: undefined })],
	["all-zero input", assistant({ usage: usage(0, 50) })],
	["error response", assistant({ stopReason: "error" })],
	["aborted response", assistant({ stopReason: "aborted" })],
] as const) {
	test(`reported input has no anchor for ${label}`, () => {
		assert.equal(reportedContextInput(message), undefined);
	});
}

test("reported input does not require valid output or totalTokens", () => {
	assert.equal(reportedContextInput(assistant({ usage: {
		...usage(), output: NaN, totalTokens: Infinity,
	} })), 1_000);
});

test("a later request attributes its 1800 input delta to the preceding completed turn", () => {
	const ledger = new ContextGrowthLedger();
	replayCompletedRun(ledger);
	assert.deepEqual(ledger.getTurn("A"), { tokens: 1_800, estimated: false });
});

test("the final text turn keeps its own output approximation rather than the request delta", () => {
	const ledger = new ContextGrowthLedger();
	replayCompletedRun(ledger);
	assert.deepEqual(ledger.getTurn("B"), { tokens: 80, estimated: true });
});

test("run growth includes the final text turn and remains estimated", () => {
	const ledger = new ContextGrowthLedger();
	replayCompletedRun(ledger);
	assert.deepEqual(ledger.getRun("run", ["A", "B"]), { tokens: 1_880, estimated: true });
});

test("an unrecorded turn is not ready", () => {
	assert.equal(new ContextGrowthLedger().getTurn("missing"), undefined);
});

for (const received of [0, 1]) {
	test(`a two-tool turn remains pending with ${received} final results`, () => {
		const ledger = new ContextGrowthLedger();
		recordToolTurn(ledger);
		if (received === 1) ledger.recordToolResult(result("read-a"));
		assert.equal(ledger.getTurn("A"), undefined);
	});
}

test("a completed local turn counts assistant output and its result content, not nested usage or details", () => {
	const ledger = new ContextGrowthLedger();
	recordToolTurn(ledger);
	recordOwnResults(ledger);
	assert.deepEqual(ledger.getTurn("A"), { tokens: 55, estimated: true });
});

test("a duplicate result replaces its previous contribution instead of accumulating", () => {
	const ledger = new ContextGrowthLedger();
	recordToolTurn(ledger);
	recordOwnResults(ledger);
	ledger.recordToolResult(result("read-a", "abcdefghijklmnopqrst"));
	assert.deepEqual(ledger.getTurn("A"), { tokens: 58, estimated: true });
});

test("pending results prevent confirmation even if the next response has usage", () => {
	const ledger = new ContextGrowthLedger();
	recordToolTurn(ledger);
	ledger.recordToolResult(result("read-a"));
	ledger.recordAssistant("run", "B", assistant({ usage: usage(12_300, 80) }));
	assert.equal(ledger.getTurn("A"), undefined);
});

test("late completion after the next response does not retroactively confirm a broken sequence", () => {
	const ledger = new ContextGrowthLedger();
	recordToolTurn(ledger);
	ledger.recordToolResult(result("read-a"));
	ledger.recordAssistant("run", "B", assistant({ usage: usage(12_300, 80) }));
	ledger.recordToolResult(result("bash-a", "abcdefghijkl", { toolName: "bash" }));
	assert.deepEqual(ledger.getTurn("A"), { tokens: 55, estimated: true });
});

for (const stopReason of ["stop", "toolUse", "length"]) {
	test(`${stopReason} is a successful final response`, () => {
		const ledger = new ContextGrowthLedger();
		ledger.recordAssistant("run", "A", assistant({
			stopReason,
			content: stopReason === "toolUse" ? [toolCall("read-a")] : [{ type: "text", text: "abcdefgh" }],
		}));
		if (stopReason === "toolUse") ledger.recordToolResult(result("read-a"));
		ledger.recordAssistant("run", "B", assistant({ usage: usage(1_200, 80) }));
		assert.deepEqual(ledger.getTurn("A"), { tokens: 200, estimated: false });
	});
}

const brokenResponses: Array<[string, Record<string, unknown>]> = [
	["missing usage", { usage: undefined }],
	["missing cache count", { usage: { ...usage(), cacheWrite: undefined } }],
	["negative input", { usage: usage(-1, 50) }],
	["nonfinite input", { usage: usage(NaN, 50) }],
	["all-zero input", { usage: usage(0, 50) }],
	["error", { stopReason: "error" }],
	["aborted", { stopReason: "aborted" }],
];

for (const [label, overrides] of brokenResponses) {
	test(`${label} cannot confirm the preceding turn`, () => {
		const ledger = new ContextGrowthLedger();
		ledger.recordAssistant("run", "A", assistant());
		ledger.recordAssistant("run", "B", assistant(overrides));
		assert.deepEqual(ledger.getTurn("A"), { tokens: 50, estimated: true });
	});

	test(`a later valid response cannot bridge over ${label}`, () => {
		const ledger = new ContextGrowthLedger();
		ledger.recordAssistant("run", "A", assistant());
		ledger.recordAssistant("run", "B", assistant(overrides));
		ledger.recordAssistant("run", "C", assistant({ usage: usage(1_800, 80) }));
		assert.deepEqual(ledger.getTurn("A"), { tokens: 50, estimated: true });
	});

	test(`a run containing a ${label} discontinuity is unavailable, not a partial sum`, () => {
		const ledger = new ContextGrowthLedger();
		ledger.recordAssistant("run", "A", assistant());
		ledger.recordAssistant("run", "B", assistant(overrides));
		ledger.recordAssistant("run", "C", assistant({ usage: usage(1_800, 80) }));
		assertUnavailable(ledger.getRun("run", ["A", "B", "C"]));
	});
}

for (const stopReason of ["error", "aborted"]) {
	test(`${stopReason} returns unavailable even with reported usage and unfulfilled calls`, () => {
		const ledger = new ContextGrowthLedger();
		ledger.recordAssistant("run", "A", assistant({ stopReason, content: [toolCall("read-a")] }));
		assertUnavailable(ledger.getTurn("A"));
	});
}

for (const [label, invalidUsage] of [
	["missing usage", undefined],
	["invalid input", usage(-1, 700)],
	["all-zero input", usage(0, 700)],
	["missing output", { ...usage(), output: undefined }],
	["negative output", usage(1_000, -1)],
	["nonfinite output", usage(1_000, Infinity)],
] as const) {
	test(`${label} uses one assistant content estimate plus its own tool results`, () => {
		const ledger = new ContextGrowthLedger();
		const message = assistant({
			usage: invalidUsage, stopReason: "toolUse",
			content: [{ type: "text", text: "abcdefgh" }, toolCall("read-a")],
		});
		ledger.recordAssistant("run", "A", message);
		ledger.recordToolResult(result("read-a"));
		assert.deepEqual(ledger.getTurn("A"), { tokens: contentEstimate(message) + 2, estimated: true });
	});
}

test("valid zero assistant output is not replaced by a content estimate", () => {
	const ledger = new ContextGrowthLedger();
	ledger.recordAssistant("run", "A", assistant({ usage: usage(1_000, 0) }));
	assert.deepEqual(ledger.getTurn("A"), { tokens: 0, estimated: true });
});

for (const [nextInput, delta] of [[1_000, 0], [800, -200]] as const) {
	test(`reported delta ${delta} is preserved without clamping or approximation`, () => {
		const ledger = new ContextGrowthLedger();
		ledger.recordAssistant("run", "A", assistant());
		ledger.recordAssistant("run", "B", assistant({ usage: usage(nextInput, 80) }));
		assert.deepEqual(ledger.getTurn("A"), { tokens: delta, estimated: false });
	});
}

test("breakChain retains the preceding turn's own approximation", () => {
	const ledger = new ContextGrowthLedger();
	ledger.recordAssistant("run", "A", assistant());
	ledger.breakChain();
	ledger.recordAssistant("run", "B", assistant({ usage: usage(1_200, 80) }));
	assert.deepEqual(ledger.getTurn("A"), { tokens: 50, estimated: true });
});

test("a same-group boundary makes the entire run unavailable", () => {
	const ledger = new ContextGrowthLedger();
	ledger.recordAssistant("run", "A", assistant());
	ledger.breakChain();
	ledger.recordAssistant("run", "B", assistant({ usage: usage(1_200, 80) }));
	assertUnavailable(ledger.getRun("run", ["A", "B"]));
});

test("breakChain with an explicit group marks it unavailable without another response", () => {
	const ledger = new ContextGrowthLedger();
	ledger.recordAssistant("run", "A", assistant());
	ledger.breakChain("run");
	assertUnavailable(ledger.getRun("run", ["A"]));
});

test("a boundary alone does not invalidate an already settled run", () => {
	const ledger = new ContextGrowthLedger();
	replayCompletedRun(ledger);
	ledger.breakChain();
	assert.deepEqual(ledger.getRun("run", ["A", "B"]), { tokens: 1_880, estimated: true });
});

test("a new group cannot confirm the preceding group's final turn", () => {
	const ledger = new ContextGrowthLedger();
	replayCompletedRun(ledger);
	ledger.recordAssistant("next-run", "C", assistant({ usage: usage(14_000, 90) }));
	assert.deepEqual(ledger.getTurn("B"), { tokens: 80, estimated: true });
});

test("starting another group preserves the preceding settled run", () => {
	const ledger = new ContextGrowthLedger();
	replayCompletedRun(ledger);
	ledger.recordAssistant("next-run", "C", assistant({ usage: usage(14_000, 90) }));
	assert.deepEqual(ledger.getRun("run", ["A", "B"]), { tokens: 1_880, estimated: true });
});

test("a named boundary in the new group cannot invalidate the preceding run", () => {
	const ledger = new ContextGrowthLedger();
	replayCompletedRun(ledger);
	ledger.breakChain("next-run");
	ledger.recordAssistant("next-run", "C", assistant({ usage: usage(14_000, 90) }));
	assert.deepEqual(ledger.getRun("run", ["A", "B"]), { tokens: 1_880, estimated: true });
});

for (const [field, value] of [
	["provider", "azure-openai"],
	["api", "openai-completions"],
	["model", "another-model"],
	["responseModel", "another-response-model"],
] as const) {
	test(`a ${field} change prevents confirmation`, () => {
		const ledger = new ContextGrowthLedger();
		ledger.recordAssistant("run", "A", assistant({ responseModel: "response-model" }));
		ledger.recordAssistant("run", "B", assistant({
			usage: usage(1_200, 80), responseModel: "response-model", [field]: value,
		}));
		assert.deepEqual(ledger.getTurn("A"), { tokens: 50, estimated: true });
	});

	test(`a ${field} change makes a same-group run unavailable`, () => {
		const ledger = new ContextGrowthLedger();
		ledger.recordAssistant("run", "A", assistant({ responseModel: "response-model" }));
		ledger.recordAssistant("run", "B", assistant({
			usage: usage(1_200, 80), responseModel: "response-model", [field]: value,
		}));
		assertUnavailable(ledger.getRun("run", ["A", "B"]));
	});
}

for (const field of ["provider", "api", "model"] as const) {
	test(`matching absent ${field} values do not constitute a valid model identity`, () => {
		const ledger = new ContextGrowthLedger();
		ledger.recordAssistant("run", "A", assistant({ [field]: undefined }));
		ledger.recordAssistant("run", "B", assistant({ [field]: undefined, usage: usage(1_200, 80) }));
		assert.deepEqual(ledger.getTurn("A"), { tokens: 50, estimated: true });
	});
}

test("a matching optional responseModel permits confirmation", () => {
	const ledger = new ContextGrowthLedger();
	ledger.recordAssistant("run", "A", assistant({ responseModel: "response-model" }));
	ledger.recordAssistant("run", "B", assistant({ responseModel: "response-model", usage: usage(1_200, 80) }));
	assert.deepEqual(ledger.getTurn("A"), { tokens: 200, estimated: false });
});

test("an unknown tool result is a boundary, not an extra contribution to the preceding turn", () => {
	const ledger = new ContextGrowthLedger();
	ledger.recordAssistant("run", "A", assistant());
	ledger.recordToolResult(result("unrecorded-tool", "x".repeat(400)));
	ledger.recordAssistant("run", "B", assistant({ usage: usage(1_200, 80) }));
	assert.deepEqual(ledger.getTurn("A"), { tokens: 50, estimated: true });
});

test("a run crossing an unknown tool result is unavailable", () => {
	const ledger = new ContextGrowthLedger();
	ledger.recordAssistant("run", "A", assistant());
	ledger.recordToolResult(result("unrecorded-tool"));
	ledger.recordAssistant("run", "B", assistant({ usage: usage(1_200, 80) }));
	assertUnavailable(ledger.getRun("run", ["A", "B"]));
});

test("a result with a mismatched tool name does not fulfill an expected result", () => {
	const ledger = new ContextGrowthLedger();
	ledger.recordAssistant("run", "A", assistant({ stopReason: "toolUse", content: [toolCall("read-a")] }));
	ledger.recordToolResult(result("read-a", "abcdefgh", { toolName: "bash" }));
	assert.equal(ledger.getTurn("A"), undefined);
});

test("a mismatched tool result prevents confirmation even after the correct result arrives", () => {
	const ledger = new ContextGrowthLedger();
	ledger.recordAssistant("run", "A", assistant({ stopReason: "toolUse", content: [toolCall("read-a")] }));
	ledger.recordToolResult(result("read-a", "abcdefgh", { toolName: "bash" }));
	ledger.recordToolResult(result("read-a"));
	ledger.recordAssistant("run", "B", assistant({ usage: usage(1_200, 80) }));
	assert.deepEqual(ledger.getTurn("A"), { tokens: 52, estimated: true });
});

test("expected run IDs reject a partial sum when a final turn has not been recorded", () => {
	const ledger = new ContextGrowthLedger();
	replayCompletedRun(ledger);
	assertUnavailable(ledger.getRun("run", ["A", "B", "missing-final-turn"]));
});

test("an incomplete expected turn makes run growth unavailable rather than returning ready turns only", () => {
	const ledger = new ContextGrowthLedger();
	ledger.recordAssistant("run", "A", assistant());
	ledger.recordAssistant("run", "B", assistant({
		usage: usage(1_200, 80), stopReason: "toolUse", content: [toolCall("read-b")],
	}));
	assertUnavailable(ledger.getRun("run", ["A", "B"]));
});

test("omitting expected IDs sums all recorded turns including final text", () => {
	const ledger = new ContextGrowthLedger();
	replayCompletedRun(ledger);
	assert.deepEqual(ledger.getRun("run"), { tokens: 1_880, estimated: true });
});

test("reset followed by replay reconstructs identical growth", () => {
	const ledger = new ContextGrowthLedger();
	replayCompletedRun(ledger);
	const before = [ledger.getTurn("A"), ledger.getTurn("B"), ledger.getRun("run", ["A", "B"])];
	ledger.reset();
	replayCompletedRun(ledger);
	assert.deepEqual([ledger.getTurn("A"), ledger.getTurn("B"), ledger.getRun("run", ["A", "B"])], before);
});

test("reset forgets prior turn IDs", () => {
	const ledger = new ContextGrowthLedger();
	replayCompletedRun(ledger);
	ledger.reset();
	assert.equal(ledger.getTurn("A"), undefined);
});

test("reset forgets prior groups", () => {
	const ledger = new ContextGrowthLedger();
	replayCompletedRun(ledger);
	ledger.reset();
	assert.equal(ledger.getRun("run"), undefined);
});

test("reset removes prior discontinuities and allows reused IDs in a new replay", () => {
	const ledger = new ContextGrowthLedger();
	ledger.recordAssistant("run", "A", assistant({ stopReason: "error" }));
	ledger.breakChain("run");
	ledger.reset();
	replayCompletedRun(ledger);
	assert.deepEqual(ledger.getRun("run", ["A", "B"]), { tokens: 1_880, estimated: true });
});

for (const [tokens, estimated, expected] of [
	[2_400, false, "ctx +2.4k"],
	[800, true, "ctx ≈+800"],
	[-200, false, "ctx -200"],
	[0, false, "ctx +0"],
	[0, true, "ctx ≈+0"],
	[999, false, "ctx +999"],
	[1_000, false, "ctx +1.0k"],
	[-1_200, true, "ctx ≈-1.2k"],
	[1_000_000, false, "ctx +1.0m"],
	[2_450_000, true, "ctx ≈+2.5m"],
	[-2_400_000, false, "ctx -2.4m"],
] as const) {
	test(`formatter displays ${tokens} ${estimated ? "estimated" : "confirmed"} tokens as ${expected}`, () => {
		assert.equal(formatContextGrowth({ tokens, estimated }), expected);
	});
}

for (const estimated of [false, true]) {
	for (const tokens of [undefined, NaN, Infinity, -Infinity]) {
		test(`formatter displays unavailable ${String(tokens)} with estimated=${estimated} as n/a`, () => {
			assert.equal(formatContextGrowth({ tokens, estimated }), "ctx n/a");
		});
	}
}

test("formatter preserves an undefined pending value", () => {
	assert.equal(formatContextGrowth(undefined), undefined);
});
