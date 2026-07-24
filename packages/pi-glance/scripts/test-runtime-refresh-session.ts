import { strict as assert } from "node:assert";
import { RuntimeRefreshSession, type RuntimeRefreshSessionHost } from "../runtime-refresh-session.js";
import type { GlanceConfig } from "../types.js";
import { cloneConfig, compaction, createRuntimeRefreshContext as createContext, gitSnapshot, message } from "./runtime-refresh-harness.js";

interface SessionHarness {
	session: RuntimeRefreshSession;
	getRenderCount(): number;
	getEnsureConfigCount(): number;
	schedules: Array<boolean | undefined>;
	setConfig(config: GlanceConfig): void;
	setNowMs(nowMs: number): void;
	setOnRender(onRender: (() => void) | undefined): void;
}

function eventMessage(role: string, options: { usage?: Record<string, unknown>; stopReason?: string; responseId?: string } = {}) {
	return {
		role,
		usage: options.usage,
		stopReason: options.stopReason,
		responseId: options.responseId,
	};
}

function createSessionHarness(initialConfig: GlanceConfig = cloneConfig()): SessionHarness {
	let config = initialConfig;
	let renderCount = 0;
	let ensureConfigCount = 0;
	let nowMs = 1000;
	let onRender: (() => void) | undefined;
	const schedules: Array<boolean | undefined> = [];
	const host: RuntimeRefreshSessionHost = {
		getConfig: () => config,
		ensureConfig: async () => {
			ensureConfigCount++;
			return config;
		},
		getThinkingLevel: () => "medium",
		getAutoCompactionEnabled: () => true,
		nowMs: () => nowMs,
		requestRender: () => {
			onRender?.();
			renderCount++;
		},
		scheduleGitRefresh: (immediate) => schedules.push(immediate),
	};
	return {
		session: new RuntimeRefreshSession(host),
		getRenderCount: () => renderCount,
		getEnsureConfigCount: () => ensureConfigCount,
		schedules,
		setConfig: (nextConfig) => {
			config = nextConfig;
		},
		setNowMs: (nextNowMs) => {
			nowMs = nextNowMs;
		},
		setOnRender: (nextOnRender) => {
			onRender = nextOnRender;
		},
	};
}

{
	const ctx = createContext({
		cwd: "/initial-repo",
		model: { id: "initial-model", provider: "anthropic", contextWindow: 300_000 },
		contextUsage: { tokens: 123_000, contextWindow: 300_000, percent: 41 },
		availableProviders: ["anthropic", "openai", "anthropic"],
		entries: [message("assistant", { usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } } })],
		branch: [compaction()],
	});
	const harness = createSessionHarness();

	const state = harness.session.ensureState(ctx.ctx);
	assert.equal(ctx.getEntryReads(), 1, "ensureState should create initial state from one full entries scan");
	assert.equal(ctx.getBranchReads(), 1, "ensureState should sync context-unknown state from one full branch scan");
	assert.equal(state.workspace.path, "/initial-repo", "ensureState should initialize workspace from full scan");
	assert.equal(state.providers.availableCount, 2, "ensureState should initialize provider count from full scan");
	assert.equal(state.model.id, "initial-model", "ensureState should initialize model from full scan");
	assert.deepEqual(state.usage, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 }, "ensureState should initialize usage totals from entries");
	assert.equal(state.context.tokens, null, "ensureState should suppress context tokens when the full scan marks context unknown");
	assert.equal(state.context.window, 300_000, "ensureState should still initialize context window when context is unknown");
	assert.equal(state.context.percent, null, "ensureState should suppress context percent when the full scan marks context unknown");

	const sameState = harness.session.ensureState(ctx.ctx);
	assert.equal(sameState, state, "repeated ensureState should return the same state object");
	assert.equal(ctx.getEntryReads(), 1, "repeated ensureState should not rescan entries");
	assert.equal(ctx.getBranchReads(), 1, "repeated ensureState should not rescan branch");
}

{
	const ctx = createContext({
		cwd: "/compact-repo",
		model: { id: "compact-model", provider: "openai", contextWindow: 222_000 },
		contextUsage: { tokens: 88_000, contextWindow: 222_000, percent: 39.6 },
		entries: [message("assistant", { usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: { total: 0.25 } } })],
		branch: [message("assistant", { usage: { totalTokens: 1 } })],
	});
	const harness = createSessionHarness();
	const state = harness.session.ensureState(ctx.ctx);
	assert.equal(state.context.tokens, 88_000, "baseline state should start with known context usage");
	const entryBaseline = ctx.getEntryReads();
	const branchBaseline = ctx.getBranchReads();

	ctx.setEntries([message("assistant", { usage: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cost: { total: 0.75 } } })]);
	ctx.setContextUsage({ tokens: 99_000, contextWindow: 222_000, percent: 44.5 });
	await harness.session.execute("session_compact", ctx.ctx);
	assert.equal(ctx.getEntryReads(), entryBaseline + 1, "session compact execute should scan entries for usage totals");
	assert.equal(ctx.getBranchReads(), branchBaseline, "session compact execute should not scan branch");
	assert.deepEqual(state.usage, { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cost: 0.75 }, "session compact should update usage totals");
	assert.equal(state.context.tokens, null, "session compact should clear visible context tokens");
	assert.equal(state.context.window, 222_000, "session compact should keep context window from current model");
	assert.equal(state.context.percent, null, "session compact should clear visible context percent");
	assert.deepEqual(harness.schedules, [true], "session compact should schedule immediate git refresh");
	assert.equal(harness.getRenderCount(), 1, "session compact should request one render after plan application");

	ctx.setContextUsage({ tokens: 55_000, contextWindow: 222_000, percent: 24.8 });
	await harness.session.execute("model_select", ctx.ctx);
	assert.equal(state.context.tokens, null, "lifecycle execute should not refill stale context while session context is unknown");
	assert.equal(state.context.percent, null, "lifecycle execute should keep percent unknown while session context is unknown");

	harness.session.clearContextUnknownAfterKnownAssistantUsage({ role: "assistant", usage: { totalTokens: 1 } });
	await harness.session.execute("model_select", ctx.ctx);
	assert.equal(state.context.tokens, 55_000, "known assistant usage should clear session context-unknown state before the next lifecycle refresh");
	assert.equal(state.context.percent, 24.8, "known assistant usage should allow lifecycle context percent to refresh");
}

{
	const ctx = createContext({
		cwd: "/reliable-repo",
		model: { id: "reliable-model", provider: "anthropic", contextWindow: 200_000 },
		contextUsage: { tokens: 66_000, contextWindow: 200_000, percent: 33 },
		entries: [message("assistant", { usage: { input: 1, output: 1, cost: { total: 0.1 } } })],
		branch: [message("assistant", { usage: { totalTokens: 1 } })],
	});
	const harness = createSessionHarness();
	const state = harness.session.ensureState(ctx.ctx);
	assert.equal(state.context.tokens, 66_000, "baseline reliable-sync state should start known");

	ctx.setBranch([compaction()]);
	ctx.setContextUsage({ tokens: 77_000, contextWindow: 200_000, percent: 38.5 });
	await harness.session.execute("session_tree", ctx.ctx);
	assert.equal(state.context.tokens, null, "reliable execute should sync unknown=true from full branch scan");
	assert.equal(state.context.percent, null, "reliable execute should clear percent when branch says context is unknown");

	ctx.setBranch([compaction(), message("assistant", { usage: { totalTokens: 1 } })]);
	ctx.setContextUsage({ tokens: 88_000, contextWindow: 200_000, percent: 44 });
	await harness.session.execute("session_tree", ctx.ctx);
	assert.equal(state.context.tokens, 88_000, "reliable execute should sync unknown=false from full branch scan");
	assert.equal(state.context.percent, 44, "reliable execute should restore context percent after full branch scan clears unknown");
}

{
	const ctx = createContext({ cwd: "/git-repo" });
	const harness = createSessionHarness();
	const state = harness.session.ensureState(ctx.ctx);
	const baselineRenderCount = harness.getRenderCount();

	assert.equal(harness.session.applyGitSnapshot("/other-repo", gitSnapshot("other")), false, "stale git snapshot should be ignored");
	assert.equal(harness.getRenderCount(), baselineRenderCount, "stale git snapshot should not request render");
	assert.equal(state.git.branch, null, "stale git snapshot should not update state");

	assert.equal(harness.session.applyGitSnapshot("/git-repo", gitSnapshot("main", 1000)), true, "matching changed git snapshot should update state");
	assert.equal(harness.getRenderCount(), baselineRenderCount + 1, "matching changed git snapshot should request render");
	assert.equal(state.git.branch, "main", "matching git snapshot should update state branch");

	assert.equal(harness.session.applyGitSnapshot("/git-repo", gitSnapshot("main", 2000)), false, "same git facts with newer updatedAt should not count as a visible state change");
	assert.equal(harness.getRenderCount(), baselineRenderCount + 1, "same git facts should not request another render");
	assert.equal(state.git.updatedAt, 2000, "same git facts should still refresh snapshot timestamp");

	assert.equal(harness.session.applyGitSnapshot("/git-repo", gitSnapshot("feature", 3000)), true, "changed git facts should update state again");
	assert.equal(harness.getRenderCount(), baselineRenderCount + 2, "changed git facts should request another render");
	assert.equal(state.git.branch, "feature", "changed git facts should update branch");
}

{
	const ctx = createContext({ contextUsage: { tokens: 10_000, contextWindow: 200_000, percent: 5 } });
	const harness = createSessionHarness();
	const state = harness.session.ensureState(ctx.ctx);
	const entryBaseline = ctx.getEntryReads();
	const branchBaseline = ctx.getBranchReads();
	const assistant = eventMessage("assistant", {
		responseId: "response-1",
		usage: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6, totalTokens: 18, cost: { total: 0.9 } },
	});

	await harness.session.messageEnd(assistant, ctx.ctx);
	assert.deepEqual(state.usage, { input: 3, output: 4, cacheRead: 5, cacheWrite: 6, cost: 0.9 }, "assistant messageEnd should apply responseId usage delta once");
	await harness.session.messageEnd({ ...assistant }, ctx.ctx);
	assert.deepEqual(state.usage, { input: 3, output: 4, cacheRead: 5, cacheWrite: 6, cost: 0.9 }, "assistant messageEnd should dedupe cloned messages by responseId");
	assert.equal(ctx.getEntryReads(), entryBaseline, "assistant messageEnd should not scan entries");
	assert.equal(ctx.getBranchReads(), branchBaseline, "assistant messageEnd should not scan branch");

	harness.session.resetAccumulators();
	await harness.session.messageEnd({ ...assistant }, ctx.ctx);
	assert.deepEqual(state.usage, { input: 6, output: 8, cacheRead: 10, cacheWrite: 12, cost: 1.8 }, "resetAccumulators should clear responseId usage dedupe");
}

{
	const ctx = createContext({ contextUsage: { tokens: 10_000, contextWindow: 200_000, percent: 5 } });
	const harness = createSessionHarness();
	const state = harness.session.ensureState(ctx.ctx);
	const assistant = eventMessage("assistant", {
		usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14, cost: { total: 0.7 } },
	});

	await harness.session.messageEnd(assistant, ctx.ctx);
	assert.deepEqual(state.usage, { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.7 }, "assistant messageEnd should apply no-responseId usage delta once");
	await harness.session.messageEnd(assistant, ctx.ctx);
	assert.deepEqual(state.usage, { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.7 }, "assistant messageEnd should dedupe no-responseId messages by object identity");
}

{
	const ctx = createContext({ contextUsage: { tokens: 10_000, contextWindow: 200_000, percent: 5 } });
	const harness = createSessionHarness();
	const state = harness.session.ensureState(ctx.ctx);
	const entryBaseline = ctx.getEntryReads();
	const branchBaseline = ctx.getBranchReads();
	const renderBaseline = harness.getRenderCount();
	const toolResult = eventMessage("toolResult", {
		usage: { input: 7, output: 8, cacheRead: 9, cacheWrite: 10, cost: { total: 1.25 } },
	});

	await harness.session.messageEnd(toolResult, ctx.ctx);
	assert.deepEqual(state.usage, { input: 7, output: 8, cacheRead: 9, cacheWrite: 10, cost: 1.25 }, "tool-result messageEnd should add nested LLM usage");
	assert.equal(harness.getRenderCount(), renderBaseline + 1, "tool-result usage should request a render");
	assert.equal(ctx.getEntryReads(), entryBaseline, "tool-result messageEnd should not scan entries");
	assert.equal(ctx.getBranchReads(), branchBaseline, "tool-result messageEnd should not scan branch");
}

{
	const ctx = createContext({
		contextUsage: { tokens: 10_000, contextWindow: 200_000, percent: 5 },
		entries: [message("assistant", { usage: { input: 9, output: 9, cost: { total: 0.9 } } })],
		branch: [compaction()],
	});
	const harness = createSessionHarness();
	const state = harness.session.ensureState(ctx.ctx);
	const entryBaseline = ctx.getEntryReads();
	const branchBaseline = ctx.getBranchReads();
	const renderBaseline = harness.getRenderCount();

	await harness.session.messageEnd(eventMessage("user", { usage: { input: 100, output: 200, totalTokens: 300, cost: { total: 99 } } }), ctx.ctx);
	assert.deepEqual(state.usage, { input: 9, output: 9, cacheRead: 0, cacheWrite: 0, cost: 0.9 }, "non-assistant messageEnd should not apply usage deltas");
	assert.equal(harness.getRenderCount(), renderBaseline, "non-assistant messageEnd should not render");
	assert.equal(ctx.getEntryReads(), entryBaseline, "non-assistant messageEnd should not scan entries");
	assert.equal(ctx.getBranchReads(), branchBaseline, "non-assistant messageEnd should not scan branch");
}

{
	const ctx = createContext({
		model: { id: "compact-message-model", provider: "anthropic", contextWindow: 200_000 },
		contextUsage: { tokens: 10_000, contextWindow: 200_000, percent: 5 },
		branch: [message("assistant", { usage: { totalTokens: 1 } })],
	});
	const harness = createSessionHarness();
	const state = harness.session.ensureState(ctx.ctx);
	await harness.session.execute("session_compact", ctx.ctx);
	assert.equal(state.context.tokens, null, "compact before messageEnd should mark context unknown");

	ctx.setContextUsage({ tokens: 64_000, contextWindow: 200_000, percent: 32 });
	await harness.session.messageEnd(eventMessage("assistant", { responseId: "known-context", usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0.1 } } }), ctx.ctx);
	assert.equal(state.context.tokens, 64_000, "known assistant messageEnd should clear context unknown before message snapshot refresh");
	assert.equal(state.context.percent, 32, "known assistant messageEnd should allow context percent to refill");
}

{
	const ctx = createContext({ contextUsage: { tokens: 10_000, contextWindow: 200_000, percent: 5 } });
	const harness = createSessionHarness();
	harness.session.agentStart();
	assert.equal(harness.getRenderCount(), 0, "agentStart without state should not ensure state or render");
	assert.equal(ctx.getEntryReads(), 0, "agentStart without state should not scan entries");
	assert.equal(ctx.getBranchReads(), 0, "agentStart without state should not scan branch");

	const state = harness.session.ensureState(ctx.ctx);
	const entryBaseline = ctx.getEntryReads();
	const branchBaseline = ctx.getBranchReads();
	harness.session.agentStart();
	assert.equal(harness.getRenderCount(), 0, "agentStart with no visible throughput change should not render");
	harness.setNowMs(1500);
	harness.setOnRender(() => {
		assert.ok(state.throughput.currentRun, "turnEnd should set current-run throughput before render");
	});
	await harness.session.turnEnd({ turnIndex: 1, message: eventMessage("assistant", { usage: { output: 10, totalTokens: 10 } }) }, ctx.ctx);
	harness.setOnRender(undefined);
	assert.ok(state.throughput.currentRun, "turnEnd should leave current-run throughput visible after render");
	assert.equal(ctx.getEntryReads(), entryBaseline, "turnEnd should not scan entries after baseline");
	assert.equal(ctx.getBranchReads(), branchBaseline, "turnEnd should not scan branch after baseline");

	const renderAfterTurnEnd = harness.getRenderCount();
	harness.session.agentStart();
	assert.equal(state.throughput.currentRun, null, "agentStart should clear a previous visible current-run throughput");
	assert.equal(harness.getRenderCount(), renderAfterTurnEnd + 1, "agentStart should render when it clears visible current-run throughput");
}

{
	const ctx = createContext({ contextUsage: { tokens: 10_000, contextWindow: 200_000, percent: 5 } });
	const harness = createSessionHarness();
	const state = harness.session.ensureState(ctx.ctx);
	const entryBaseline = ctx.getEntryReads();
	const branchBaseline = ctx.getBranchReads();
	harness.session.agentStart();
	harness.setNowMs(1400);
	await harness.session.turnEnd({ turnIndex: 1, message: eventMessage("assistant", { usage: { output: 4, totalTokens: 4 } }) }, ctx.ctx);
	assert.ok(state.throughput.currentRun, "setup turnEnd should set current-run throughput");
	harness.setNowMs(1800);
	harness.setOnRender(() => {
		assert.ok(state.throughput.lastTurn, "agentEnd should set last-turn throughput before render");
		assert.equal(state.throughput.currentRun, null, "agentEnd should clear current-run throughput before render");
	});
	await harness.session.agentEnd({ messages: [eventMessage("assistant", { usage: { output: 8, totalTokens: 8 } })] }, ctx.ctx);
	harness.setOnRender(undefined);
	assert.ok(state.throughput.lastTurn, "agentEnd should leave last-turn throughput visible after render");
	assert.equal(state.throughput.currentRun, null, "agentEnd should leave current-run throughput cleared");
	assert.equal(ctx.getEntryReads(), entryBaseline, "agentEnd should not scan entries after baseline");
	assert.equal(ctx.getBranchReads(), branchBaseline, "agentEnd should not scan branch after baseline");
}

{
	const ctx = createContext({ contextUsage: { tokens: 10_000, contextWindow: 200_000, percent: 5 } });
	const harness = createSessionHarness();
	const state = harness.session.ensureState(ctx.ctx);
	const assistant = eventMessage("assistant", { responseId: "reset-me", usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.1 } } });
	await harness.session.messageEnd(assistant, ctx.ctx);
	await harness.session.messageEnd({ ...assistant }, ctx.ctx);
	assert.deepEqual(state.usage, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1 }, "setup should confirm assistant responseId dedupe is active");

	harness.session.resetAccumulators();
	await harness.session.messageEnd({ ...assistant }, ctx.ctx);
	assert.deepEqual(state.usage, { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.2 }, "resetAccumulators should clear assistant responseId dedupe");

	harness.session.agentStart();
	harness.setNowMs(2000);
	harness.session.sessionShutdown();
	await harness.session.agentEnd({ messages: [eventMessage("assistant", { usage: { output: 10, totalTokens: 10 } })] }, ctx.ctx);
	assert.equal(state.throughput.lastTurn, null, "sessionShutdown should reset throughput tracker so a later agentEnd cannot create last-turn throughput");
}

console.log("✓ runtime refresh session checks passed");
