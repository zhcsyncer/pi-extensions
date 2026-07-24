import { strict as assert } from "node:assert";
import type { ThroughputClock, ThroughputRunStateIntent as ExportedThroughputRunStateIntent } from "../throughput-run-tracker.js";

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

type ThroughputRunStateIntent =
	| { kind: "none" }
	| { kind: "set-current-run"; currentRun: TurnThroughputExpectation }
	| { kind: "clear-current-run" }
	| { kind: "set-last-turn-and-clear-current-run"; lastTurn: TurnThroughputExpectation };

interface ThroughputRunTrackerInstance {
	start(startedAtMs: number): ThroughputRunStateIntent;
	checkpoint(turnIndex: unknown, message: unknown, nowMs: ThroughputClock): ThroughputRunStateIntent;
	finish(messages: unknown, nowMs: ThroughputClock): ThroughputRunStateIntent;
	reset(): ThroughputRunStateIntent;
}

const _typeExportCheck: ExportedThroughputRunStateIntent = { kind: "none" };
assert.equal(_typeExportCheck.kind, "none", "ThroughputRunStateIntent type export should accept the none intent shape");

type ThroughputRunTrackerConstructor = new () => ThroughputRunTrackerInstance;

const modulePath = "../throughput-run-tracker.js";
let trackerModule: Record<string, unknown>;
try {
	trackerModule = (await import(modulePath)) as Record<string, unknown>;
} catch (error) {
	assert.fail(`throughput-run-tracker.ts should exist as a pure lifecycle module exporting ThroughputRunTracker; import failed: ${(error as Error).message}`);
}

assert.equal(typeof trackerModule.ThroughputRunTracker, "function", "throughput-run-tracker.ts should export ThroughputRunTracker");
assert.equal("ThroughputRunStateIntent" in trackerModule, false, "ThroughputRunStateIntent should stay a compile-time-only type export");
assert.equal("ThroughputClock" in trackerModule, false, "ThroughputClock should stay a compile-time-only type export");

const ThroughputRunTracker = trackerModule.ThroughputRunTracker as ThroughputRunTrackerConstructor;

function tracker(): ThroughputRunTrackerInstance {
	return new ThroughputRunTracker();
}

function assistant(output: number, extras: Record<string, unknown> = {}, stopReason = "stop"): unknown {
	return {
		role: "assistant",
		stopReason,
		usage: { output, totalTokens: output, ...extras },
	};
}

function user(output: number): unknown {
	return { role: "user", usage: { output, totalTokens: output } };
}

function clock(value: number): ThroughputClock {
	return () => value;
}

function throwingClock(message = "tracker should not read the clock on this path"): ThroughputClock {
	return () => {
		throw new Error(message);
	};
}

function expectTurn(actual: TurnThroughputExpectation, expected: TurnThroughputExpectation, message: string): void {
	assert.deepEqual(actual, expected, message);
}

function expectCurrent(intent: ThroughputRunStateIntent, expected: TurnThroughputExpectation, message: string): void {
	assert.equal(intent.kind, "set-current-run", message);
	expectTurn((intent as Extract<ThroughputRunStateIntent, { kind: "set-current-run" }>).currentRun, expected, message);
}

function expectFinal(intent: ThroughputRunStateIntent, expected: TurnThroughputExpectation, message: string): void {
	assert.equal(intent.kind, "set-last-turn-and-clear-current-run", message);
	expectTurn((intent as Extract<ThroughputRunStateIntent, { kind: "set-last-turn-and-clear-current-run" }>).lastTurn, expected, message);
}

{
	const run = tracker();
	assert.deepEqual(run.start(1_000), { kind: "clear-current-run" }, "start should reset local lifecycle state and request stale currentRun clearing");
}

{
	const run = tracker();
	run.start(1_000);
	expectCurrent(
		run.checkpoint(0, assistant(40), clock(2_250)),
		{
			startedAtMs: 1_000,
			endedAtMs: 2_250,
			elapsedMs: 1_250,
			tokensPerSecond: 32,
			usage: {
				input: 0,
				output: 40,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 40,
				assistantMessages: 1,
			},
		},
		"accepted assistant checkpoint should set a provisional currentRun",
	);
}

{
	const run = tracker();
	assert.deepEqual(
		run.checkpoint(0, assistant(40), throwingClock()),
		{ kind: "none" },
		"checkpoint without start should be a no-op and must not read the clock",
	);
}

{
	const run = tracker();
	run.start(1_000);
	run.checkpoint(7, assistant(20), clock(2_000));
	assert.deepEqual(
		run.checkpoint(7, assistant(20), throwingClock()),
		{ kind: "none" },
		"duplicate finite turnIndex should be ignored after first accepted assistant checkpoint and must not read the clock",
	);
}

{
	const run = tracker();
	run.start(1_000);
	assert.deepEqual(
		run.checkpoint(7, user(99), throwingClock()),
		{ kind: "none" },
		"non-assistant checkpoint should be ignored and must not read the clock",
	);
	expectCurrent(
		run.checkpoint(7, assistant(20), clock(2_000)),
		{
			startedAtMs: 1_000,
			endedAtMs: 2_000,
			elapsedMs: 1_000,
			tokensPerSecond: 20,
			usage: {
				input: 0,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 20,
				assistantMessages: 1,
			},
		},
		"non-assistant checkpoint should not mark a finite turnIndex as seen",
	);
}

{
	const run = tracker();
	run.start(1_000);
	run.checkpoint(0, assistant(20, { input: 3, cacheRead: 2 }), clock(2_000));
	expectCurrent(
		run.checkpoint(1, assistant(60, { input: 7, cacheWrite: 5 }), clock(4_000)),
		{
			startedAtMs: 1_000,
			endedAtMs: 4_000,
			elapsedMs: 3_000,
			tokensPerSecond: 80 / 3,
			usage: {
				input: 10,
				output: 80,
				cacheRead: 2,
				cacheWrite: 5,
				totalTokens: 80,
				assistantMessages: 2,
			},
		},
		"accepted assistant checkpoints should accumulate into the provisional currentRun",
	);
}

{
	const run = tracker();
	run.start(1_000);
	assert.deepEqual(
		run.checkpoint(0, assistant(0), clock(2_000)),
		{ kind: "clear-current-run" },
		"accepted assistant checkpoint with invalid measurement should clear currentRun",
	);
	expectCurrent(
		run.checkpoint(1, assistant(20), clock(3_000)),
		{
			startedAtMs: 1_000,
			endedAtMs: 3_000,
			elapsedMs: 2_000,
			tokensPerSecond: 10,
			usage: {
				input: 0,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 20,
				assistantMessages: 2,
			},
		},
		"invalid accepted checkpoints should remain in the accumulator for later valid provisional measurements",
	);
}

{
	const run = tracker();
	run.start(1_000);
	run.checkpoint(0, assistant(20), clock(2_000));
	expectFinal(
		run.finish([assistant(90)], clock(3_000)),
		{
			startedAtMs: 1_000,
			endedAtMs: 3_000,
			elapsedMs: 2_000,
			tokensPerSecond: 45,
			usage: {
				input: 0,
				output: 90,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 90,
				assistantMessages: 1,
			},
		},
		"finish should calculate final lastTurn from event.messages rather than the checkpoint accumulator",
	);
	assert.deepEqual(
		run.finish([assistant(1)], throwingClock()),
		{ kind: "clear-current-run" },
		"finish should reset internals after a valid final and no-start finish must not read the clock",
	);
}

{
	const run = tracker();
	assert.deepEqual(
		run.finish([assistant(50)], throwingClock()),
		{ kind: "clear-current-run" },
		"finish without start should clear currentRun only and must not read the clock",
	);
}

{
	const run = tracker();
	run.start(1_000);
	assert.deepEqual(
		run.finish([assistant(0)], clock(2_000)),
		{ kind: "clear-current-run" },
		"invalid final should clear currentRun only, preserving lastTurn by intent shape",
	);
	assert.deepEqual(
		run.finish([assistant(20)], throwingClock()),
		{ kind: "clear-current-run" },
		"invalid final should reset internals after finish",
	);
}

{
	const run = tracker();
	run.start(1_000);
	assert.deepEqual(
		run.finish({ messages: [assistant(20)] }, clock(2_000)),
		{ kind: "clear-current-run" },
		"non-array final messages should clear currentRun only, preserving lastTurn by intent shape",
	);
	assert.deepEqual(
		run.finish([assistant(20)], throwingClock()),
		{ kind: "clear-current-run" },
		"non-array final should reset internals after finish",
	);
}

{
	const run = tracker();
	run.start(1_000);
	run.checkpoint(0, assistant(20), clock(2_000));
	assert.deepEqual(run.reset(), { kind: "none" }, "reset should clear internals only and return no visible intent");
	assert.deepEqual(
		run.checkpoint(1, assistant(20), throwingClock()),
		{ kind: "none" },
		"checkpoint after reset should see no active start and must not read the clock",
	);
	assert.deepEqual(
		run.finish([assistant(20)], throwingClock()),
		{ kind: "clear-current-run" },
		"finish after reset should clear currentRun only and must not read the clock",
	);
}

{
	const run = tracker();
	run.start(1_000);
	run.checkpoint(undefined, assistant(20), clock(2_000));
	expectCurrent(
		run.checkpoint(undefined, assistant(30), clock(3_000)),
		{
			startedAtMs: 1_000,
			endedAtMs: 3_000,
			elapsedMs: 2_000,
			tokensPerSecond: 25,
			usage: {
				input: 0,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 50,
				assistantMessages: 2,
			},
		},
		"undefined turnIndex checkpoints should not be duplicate-guarded",
	);
}

console.log("✓ throughput run tracker checks passed");
