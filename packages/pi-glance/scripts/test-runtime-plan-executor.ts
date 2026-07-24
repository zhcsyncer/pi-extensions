import { strict as assert } from "node:assert";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyRuntimeRefreshPlan, type RuntimePlanExecutionInput } from "../runtime-plan-executor.js";
import { runtimePlanFor, type RuntimeRefreshPlan } from "../runtime-policy.js";
import type { GlanceConfig, GlanceState, UsageTotals } from "../types.js";
import { cloneConfig, compaction, createRuntimeRefreshContext as createContext, gitSnapshot, message } from "./runtime-refresh-harness.js";

interface ExecutorResult {
	unknown: boolean;
	unknownWrites: boolean[];
	schedules: Array<boolean | undefined>;
}

function usage(input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0): UsageTotals {
	return { input, output, cacheRead, cacheWrite, cost };
}

function baseState(overrides: Partial<GlanceState> = {}): GlanceState {
	return {
		workspace: { name: "repo", path: "/repo" },
		git: gitSnapshot({ repo: false, branch: null, updatedAt: 0 }),
		providers: { availableCount: 1 },
		model: { id: "initial-model", provider: "initial-provider", displayName: "initial-model", thinking: "off", reasoning: false },
		runtime: {
			autoCompactEnabled: true,
		},
		context: { tokens: 10_000, window: 100_000, percent: 10 },
		usage: usage(100, 200, 300, 400, 1.5),
		throughput: { lastTurn: null, currentRun: null },
		version: 0,
		...overrides,
	};
}

function executePlan(options: { state: GlanceState; ctx: ExtensionContext; plan: RuntimeRefreshPlan; config?: GlanceConfig; thinkingLevel?: string; unknown?: boolean }): ExecutorResult {
	let unknown = options.unknown ?? false;
	const unknownWrites: boolean[] = [];
	const schedules: Array<boolean | undefined> = [];
	const input: RuntimePlanExecutionInput = {
		state: options.state,
		config: options.config ?? cloneConfig(),
		ctx: options.ctx,
		plan: options.plan,
		getThinkingLevel: () => options.thinkingLevel ?? "medium",
		getAutoCompactionEnabled: () => true,
		unknownContextAfterLatestCompaction: unknown,
		setUnknownContextAfterLatestCompaction: (value) => {
			unknown = value;
			unknownWrites.push(value);
		},
		scheduleGitRefresh: (immediate) => schedules.push(immediate),
	};
	applyRuntimeRefreshPlan(input);
	return { unknown, unknownWrites, schedules };
}

{
	const state = baseState();
	const ctx = createContext({
		cwd: "/reliable-repo",
		model: { id: "reliable-model", provider: "anthropic", contextWindow: 300_000 },
		contextUsage: { tokens: 123_000, contextWindow: 300_000, percent: 41 },
		availableProviders: ["anthropic", "openai", "anthropic"],
		entries: [message("assistant", { usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } } })],
		branch: [compaction()],
	});
	const result = executePlan({ state, ctx: ctx.ctx, plan: runtimePlanFor("session_tree"), thinkingLevel: "high" });

	assert.equal(ctx.getEntryReads(), 1, "reliable snapshot should scan session entries for usage totals");
	assert.equal(ctx.getBranchReads(), 1, "reliable snapshot should scan session branch for compaction context status");
	assert.deepEqual(result.unknownWrites, [true], "reliable snapshot should sync explicit context-unknown state from the full scan");
	assert.equal(result.unknown, true, "reliable snapshot should expose the full-scan context-unknown result to runtime state");
	assert.equal(state.workspace.path, "/reliable-repo", "reliable snapshot should refresh workspace");
	assert.equal(state.providers.availableCount, 2, "reliable snapshot should refresh provider count");
	assert.equal(state.model.id, "reliable-model", "reliable snapshot should refresh model id");
	assert.deepEqual(state.usage, usage(1, 2, 3, 4, 0.5), "reliable snapshot should reconcile usage totals from entries");
	assert.equal(state.context.tokens, null, "reliable snapshot should suppress context tokens while full scan says context is unknown");
	assert.equal(state.context.window, 300_000, "reliable snapshot should still refresh context window");
	assert.equal(state.context.percent, null, "reliable snapshot should suppress context percent while full scan says context is unknown");
	assert.deepEqual(result.schedules, [true], "reliable immediate git plan should schedule an immediate refresh");
}

{
	const state = baseState({ context: { tokens: 88_000, window: 100_000, percent: 88 } });
	const ctx = createContext({
		cwd: "/compact-repo",
		model: { id: "compact-model", provider: "openai", contextWindow: 222_000 },
		contextUsage: { tokens: 99_000, contextWindow: 222_000, percent: 44.5 },
		entries: [message("assistant", { usage: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cost: { total: 0.75 } } })],
		branch: [compaction(), message("assistant", { usage: { totalTokens: 100 } })],
	});
	const result = executePlan({ state, ctx: ctx.ctx, plan: runtimePlanFor("session_compact"), thinkingLevel: "low" });

	assert.equal(ctx.getEntryReads(), 1, "compact snapshot should scan entries for usage totals");
	assert.equal(ctx.getBranchReads(), 0, "compact snapshot must not scan branch");
	assert.deepEqual(result.unknownWrites, [true], "compact snapshot should explicitly mark context as unknown");
	assert.equal(result.unknown, true, "compact snapshot should keep runtime context-unknown state true");
	assert.deepEqual(state.usage, usage(5, 6, 7, 8, 0.75), "compact snapshot should refresh usage totals from entries");
	assert.equal(state.context.tokens, null, "compact snapshot should clear visible context tokens");
	assert.equal(state.context.window, 222_000, "compact snapshot should preserve/update context window from current model inputs");
	assert.equal(state.context.percent, null, "compact snapshot should clear visible context percent");
	assert.deepEqual(result.schedules, [true], "compact immediate git plan should schedule an immediate refresh");
}

{
	const previousUsage = usage(10, 20, 30, 40, 2);
	const previousContext = { tokens: 12_345, window: 500_000, percent: 2.469 };
	const state = baseState({ usage: previousUsage, context: { ...previousContext }, model: { id: "same-model", provider: "openai", displayName: "same-model", thinking: "off" } });
	const ctx = createContext({
		model: { id: "same-model", provider: "openai", contextWindow: previousContext.window },
		contextUsage: { tokens: 999_999, contextWindow: previousContext.window, percent: 99 },
		availableProviders: ["openai", "anthropic"],
		entries: [message("assistant", { usage: { input: 1000 } })],
		branch: [compaction()],
	});
	const result = executePlan({ state, ctx: ctx.ctx, plan: runtimePlanFor("thinking_level_select"), thinkingLevel: "high" });

	assert.equal(ctx.getEntryReads(), 0, "thinking snapshot should not scan entries");
	assert.equal(ctx.getBranchReads(), 0, "thinking snapshot should not scan branch");
	assert.deepEqual(state.usage, previousUsage, "thinking snapshot should preserve usage totals");
	assert.deepEqual(state.context, previousContext, "thinking snapshot should preserve current context usage values");
	assert.equal(state.model.thinking, "high", "thinking snapshot should update visible thinking level");
	assert.equal(state.providers.availableCount, 2, "thinking snapshot should still update provider count");
	assert.deepEqual(result.schedules, [], "thinking snapshot should not schedule git refreshes");
}

{
	const lifecycleState = baseState({ context: { tokens: 1, window: 100_000, percent: 1 } });
	const lifecycleCtx = createContext({
		model: { id: "lifecycle-model", provider: "anthropic", contextWindow: 400_000 },
		contextUsage: { tokens: 44_000, contextWindow: 400_000, percent: 11 },
		entries: [message("assistant", { usage: { input: 100 } })],
		branch: [compaction()],
	});
	const lifecycleResult = executePlan({ state: lifecycleState, ctx: lifecycleCtx.ctx, plan: runtimePlanFor("model_select") });
	assert.equal(lifecycleCtx.getEntryReads(), 0, "lifecycle snapshot should not scan entries");
	assert.equal(lifecycleCtx.getBranchReads(), 0, "lifecycle snapshot should not scan branch");
	assert.equal(lifecycleState.context.tokens, 44_000, "lifecycle snapshot should refresh context tokens from ctx.getContextUsage");
	assert.deepEqual(lifecycleResult.schedules, [true], "model_select lifecycle plan should schedule immediate git refresh");

	const messageState = baseState({ context: { tokens: 2, window: 100_000, percent: 2 } });
	const messageCtx = createContext({
		model: { id: "message-model", provider: "openai", contextWindow: 250_000 },
		contextUsage: { tokens: 25_000, contextWindow: 250_000, percent: 10 },
		entries: [message("assistant", { usage: { input: 200 } })],
		branch: [compaction()],
	});
	const messageResult = executePlan({ state: messageState, ctx: messageCtx.ctx, plan: runtimePlanFor("message_end", { messageRole: "assistant" }) });
	assert.equal(messageCtx.getEntryReads(), 0, "message snapshot should not scan entries");
	assert.equal(messageCtx.getBranchReads(), 0, "message snapshot should not scan branch");
	assert.equal(messageState.context.tokens, 25_000, "message snapshot should refresh context tokens through the lifecycle reader");
	assert.deepEqual(messageResult.schedules, [], "message on-workspace-change git plan should not schedule when workspace is unchanged");
}

{
	const immediateState = baseState();
	const immediateCtx = createContext({ cwd: "/repo" });
	assert.deepEqual(
		executePlan({ state: immediateState, ctx: immediateCtx.ctx, plan: runtimePlanFor("model_select") }).schedules,
		[true],
		"immediate git plan should schedule even when workspace is unchanged",
	);

	const stableWorkspaceState = baseState();
	const stableWorkspaceCtx = createContext({ cwd: "/repo" });
	assert.deepEqual(
		executePlan({ state: stableWorkspaceState, ctx: stableWorkspaceCtx.ctx, plan: runtimePlanFor("turn_start") }).schedules,
		[],
		"onWorkspaceChange git plan should not schedule when workspace is unchanged",
	);

	const changedWorkspaceState = baseState();
	const changedWorkspaceCtx = createContext({ cwd: "/next-repo" });
	assert.deepEqual(
		executePlan({ state: changedWorkspaceState, ctx: changedWorkspaceCtx.ctx, plan: runtimePlanFor("turn_start") }).schedules,
		[true],
		"onWorkspaceChange git plan should schedule immediately when workspace changes",
	);

	const neverState = baseState();
	const neverCtx = createContext({ cwd: "/next-repo" });
	assert.deepEqual(
		executePlan({ state: neverState, ctx: neverCtx.ctx, plan: runtimePlanFor("thinking_level_select") }).schedules,
		[],
		"never git plan should not schedule refreshes",
	);
}

{
	const state = baseState({ context: { tokens: null, window: 200_000, percent: null } });
	const ctx = createContext({
		model: { id: "post-compact-model", provider: "anthropic", contextWindow: 200_000 },
		contextUsage: { tokens: 66_000, contextWindow: 200_000, percent: 33 },
	});
	const result = executePlan({ state, ctx: ctx.ctx, plan: runtimePlanFor("model_select"), unknown: true });

	assert.equal(ctx.getEntryReads(), 0, "post-compaction lifecycle refresh should not scan entries");
	assert.equal(ctx.getBranchReads(), 0, "post-compaction lifecycle refresh should not scan branch");
	assert.deepEqual(result.unknownWrites, [], "lifecycle refresh should not clear explicit context-unknown state by itself");
	assert.equal(result.unknown, true, "lifecycle refresh should keep context unknown until runtime sees known assistant usage or a full scan");
	assert.equal(state.context.tokens, null, "unknown context should suppress stale lifecycle context tokens");
	assert.equal(state.context.window, 200_000, "unknown context should still keep the current context window");
	assert.equal(state.context.percent, null, "unknown context should suppress stale lifecycle context percent");
}

console.log("✓ runtime plan executor checks passed");
