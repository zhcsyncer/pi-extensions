import { strict as assert } from "node:assert";
import { defaultConfig } from "../config.js";
import { createInitialState } from "../state.js";
import type { StateInputs } from "../runtime-snapshot.js";
import { testState } from "./helpers.js";

interface TurnThroughputFixture {
	startedAtMs: number;
	endedAtMs: number;
	elapsedMs: number;
	tokensPerSecond: number;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		assistantMessages: number;
	};
}

type GlanceStateRecord = ReturnType<typeof testState> & Record<string, unknown>;
type ThroughputStateMutation = (state: GlanceStateRecord, turn: TurnThroughputFixture | null) => boolean;
type ThroughputStateClear = (state: GlanceStateRecord) => boolean;

function throughput(state: unknown): { lastTurn?: unknown; currentRun?: unknown } {
	return ((state as { throughput?: { lastTurn?: unknown; currentRun?: unknown } }).throughput ?? {}) as { lastTurn?: unknown; currentRun?: unknown };
}

const inputs: StateInputs = {
	cwd: "/repo",
	model: { id: "gpt-5.5", provider: "openai", contextWindow: 200_000 },
	thinkingLevel: "off",
	contextUsage: undefined,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	runtime: {
		autoCompactEnabled: true,
	},
	availableProviderCount: 1,
	unknownContextAfterLatestCompaction: false,
};

const initial = createInitialState(inputs, defaultConfig()) as GlanceStateRecord;
assert.deepEqual(
	throughput(initial),
	{ lastTurn: null, currentRun: null },
	"createInitialState should initialize throughput.lastTurn and throughput.currentRun to null so unknown/provisional/final render states are explicit",
);

const stateModule = (await import("../state.js")) as Record<string, unknown>;
const setLastTurnThroughput = stateModule.setLastTurnThroughput as ThroughputStateMutation | undefined;
const clearLastTurnThroughput = stateModule.clearLastTurnThroughput as ThroughputStateClear | undefined;
const setCurrentRunThroughput = stateModule.setCurrentRunThroughput as ThroughputStateMutation | undefined;
const clearCurrentRunThroughput = stateModule.clearCurrentRunThroughput as ThroughputStateClear | undefined;

assert.equal(typeof setLastTurnThroughput, "function", "state.ts should export setLastTurnThroughput(state, turn)");
assert.equal(typeof clearLastTurnThroughput, "function", "state.ts should export clearLastTurnThroughput(state)");
assert.equal(typeof setCurrentRunThroughput, "function", "state.ts should export setCurrentRunThroughput(state, turn) for provisional Reply speed");
assert.equal(typeof clearCurrentRunThroughput, "function", "state.ts should export clearCurrentRunThroughput(state)");

const finalSample: TurnThroughputFixture = {
	startedAtMs: 1_000,
	endedAtMs: 3_500,
	elapsedMs: 2_500,
	tokensPerSecond: 20,
	usage: {
		input: 10,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 60,
		assistantMessages: 1,
	},
};

const currentSample: TurnThroughputFixture = {
	startedAtMs: 5_000,
	endedAtMs: 6_250,
	elapsedMs: 1_250,
	tokensPerSecond: 32,
	usage: {
		input: 4,
		output: 40,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 44,
		assistantMessages: 1,
	},
};

const state = testState({ version: 7 }) as GlanceStateRecord;
(state as unknown as { throughput: { lastTurn: unknown; currentRun: unknown } }).throughput = { lastTurn: null, currentRun: null };

assert.equal(setLastTurnThroughput!(state, finalSample), true, "setting final throughput from null should report a state change");
assert.deepEqual(throughput(state).lastTurn, finalSample, "setLastTurnThroughput should store the latest finalized turn throughput snapshot");
assert.deepEqual(throughput(state).currentRun, null, "setting final throughput should not implicitly mutate currentRun; runtime clears currentRun explicitly");
assert.equal(state.version, 8, "setting a changed final throughput snapshot should increment state.version exactly once");

assert.equal(setLastTurnThroughput!(state, { ...finalSample }), false, "setting an equivalent final throughput snapshot should be a no-op");
assert.equal(state.version, 8, "equivalent final throughput snapshots should not increment version");

const changedFinal: TurnThroughputFixture = { ...finalSample, endedAtMs: 4_000, elapsedMs: 3_000, tokensPerSecond: 16.6666666667 };
assert.equal(setLastTurnThroughput!(state, changedFinal), true, "setting a different final throughput snapshot should report a change");
assert.deepEqual(throughput(state).lastTurn, changedFinal, "different final throughput snapshot should replace the previous final");
assert.equal(state.version, 9, "different final throughput snapshot should increment state.version");

assert.equal(setCurrentRunThroughput!(state, currentSample), true, "setting currentRun from null should report a state change");
assert.deepEqual(throughput(state).currentRun, currentSample, "setCurrentRunThroughput should store the latest provisional current run snapshot");
assert.deepEqual(throughput(state).lastTurn, changedFinal, "setting currentRun should preserve the last finalized throughput snapshot");
assert.equal(state.version, 10, "setting changed currentRun should increment state.version exactly once");

assert.equal(setCurrentRunThroughput!(state, { ...currentSample }), false, "setting an equivalent currentRun snapshot should be a no-op");
assert.equal(state.version, 10, "equivalent currentRun snapshots should not increment version");

const changedCurrent: TurnThroughputFixture = { ...currentSample, endedAtMs: 7_000, elapsedMs: 2_000, tokensPerSecond: 20 };
assert.equal(setCurrentRunThroughput!(state, changedCurrent), true, "setting a different currentRun snapshot should report a change");
assert.deepEqual(throughput(state).currentRun, changedCurrent, "different currentRun snapshot should replace the previous provisional snapshot");
assert.deepEqual(throughput(state).lastTurn, changedFinal, "changing currentRun should still preserve lastTurn");
assert.equal(state.version, 11, "different currentRun snapshot should increment state.version");

assert.equal(clearCurrentRunThroughput!(state), true, "clearing a present currentRun snapshot should report a state change");
assert.deepEqual(throughput(state), { lastTurn: changedFinal, currentRun: null }, "clearCurrentRunThroughput should leave lastTurn intact and only clear currentRun");
assert.equal(state.version, 12, "clearing present currentRun should increment state.version");

assert.equal(clearCurrentRunThroughput!(state), false, "clearing an already-null currentRun should be a no-op");
assert.equal(state.version, 12, "clearing an already-null currentRun should not increment version");

assert.equal(clearLastTurnThroughput!(state), true, "clearing a present final throughput snapshot should report a state change");
assert.deepEqual(throughput(state), { lastTurn: null, currentRun: null }, "clearLastTurnThroughput should leave throughput slots null when currentRun is already null");
assert.equal(state.version, 13, "clearing present lastTurn should increment state.version");

console.log("✓ throughput state checks passed");
