import { strict as assert } from "node:assert";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compactInputsFromContext, hasUnknownContextAfterLatestCompaction, lifecycleInputsFromContext, stateInputsFromContext, thinkingInputsFromContext, usageTotalsFromAssistantMessage, usageTotalsFromEntries, type StateSessionEntry } from "../runtime-snapshot.js";

function message(role: string, options: { usage?: Record<string, unknown>; stopReason?: string } = {}): StateSessionEntry {
	return {
		type: "message",
		message: {
			role,
			usage: options.usage,
			stopReason: options.stopReason,
		},
	} as StateSessionEntry;
}

function compaction(): StateSessionEntry {
	return { type: "compaction" };
}

interface FakeContextOptions {
	cwd?: string;
	sessionCwd?: string;
	model?: { id?: string; provider?: string; contextWindow?: number; reasoning?: boolean };
	sessionName?: string;
	usingOAuth?: boolean;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
	availableProviders?: readonly unknown[];
	entries?: readonly StateSessionEntry[];
	branch?: readonly StateSessionEntry[];
}

function fakeContext(options: FakeContextOptions = {}): ExtensionContext {
	return {
		cwd: options.cwd ?? "/fallback",
		model: options.model,
		modelRegistry: {
			getAvailable: () => (options.availableProviders ?? ["test-provider"]).map((provider, index) => ({ provider, id: `model-${index}` })),
			isUsingOAuth: () => options.usingOAuth ?? false,
		},
		getContextUsage: () => options.contextUsage,
		sessionManager: {
			getCwd: () => options.sessionCwd,
			getSessionName: () => options.sessionName,
			getEntries: () => options.entries ?? [],
			getBranch: () => options.branch ?? [],
		},
	} as unknown as ExtensionContext;
}

const fallbackInputs = stateInputsFromContext(fakeContext({ cwd: "/fallback", sessionCwd: "" }), "medium");
assert.equal(fallbackInputs.cwd, "/fallback", "cwd should fall back to ctx.cwd when session cwd is empty");
assert.equal(fallbackInputs.thinkingLevel, "medium", "thinking level should be copied from caller input");

const sessionCwdInputs = stateInputsFromContext(fakeContext({ cwd: "/fallback", sessionCwd: "/workspace" }), "high");
assert.equal(sessionCwdInputs.cwd, "/workspace", "session cwd should win over ctx.cwd");

const modelInputs = stateInputsFromContext(
	fakeContext({
		model: {
			id: "claude-test",
			provider: "anthropic",
			contextWindow: 200000,
			ignored: "drop-me",
		} as { id?: string; provider?: string; contextWindow?: number } & { ignored?: string },
	}),
	"off",
);
assert.deepEqual(
	modelInputs.model,
	{ id: "claude-test", provider: "anthropic", contextWindow: 200000 },
	"model extraction should copy only id/provider/contextWindow",
);
assert.equal(stateInputsFromContext(fakeContext({ model: undefined }), "off").model, undefined, "undefined ctx.model should produce undefined model inputs");

const contextUsageInputs = stateInputsFromContext(
	fakeContext({ contextUsage: { tokens: null, contextWindow: 128000, percent: null } }),
	"off",
);
assert.deepEqual(
	contextUsageInputs.contextUsage,
	{ tokens: null, contextWindow: 128000, percent: null },
	"present context usage should be copied exactly",
);
assert.equal(stateInputsFromContext(fakeContext({ contextUsage: undefined }), "off").contextUsage, undefined, "missing context usage should stay undefined");
assert.equal(stateInputsFromContext(fakeContext({ availableProviders: ["openai", "anthropic", "openai", ""] }), "off").availableProviderCount, 2, "provider count should deduplicate non-empty available provider names from modelRegistry");
assert.equal(stateInputsFromContext(fakeContext({ availableProviders: [] }), "off").availableProviderCount, 1, "provider count should keep one-provider fallback when no available models are configured");
assert.equal(stateInputsFromContext(fakeContext({ availableProviders: [undefined, 123] }), "off").availableProviderCount, 1, "provider count should ignore invalid provider names and keep fallback minimum");

const runtimeFacts = stateInputsFromContext(
	fakeContext({
		model: { id: "sub-model", provider: "anthropic", contextWindow: 200000, reasoning: true },
		sessionName: "footer work",
		usingOAuth: true,
		entries: [message("assistant", { usage: { input: 25, cacheRead: 75, cacheWrite: 0 } })],
	}),
	"high",
	false,
);
assert.deepEqual(
	runtimeFacts.runtime,
	{ autoCompactEnabled: false },
	"reliable snapshot should expose only the auto-compaction runtime fact used by the input surface",
);
assert.equal(runtimeFacts.model?.reasoning, true, "model snapshot should retain reasoning support for the model segment");

const cheapThinkingInputs = thinkingInputsFromContext(
	{
		model: { id: "cheap-model", provider: "cheap-provider", contextWindow: 123000 },
		modelRegistry: {
			getAvailable: () => [{ provider: "cheap-provider" }, { provider: "other-provider" }, { provider: "cheap-provider" }],
		},
		getContextUsage: () => {
			throw new Error("thinking inputs should not read context usage");
		},
		sessionManager: {
			getCwd: () => {
				throw new Error("thinking inputs should not read session cwd");
			},
			getEntries: () => {
				throw new Error("thinking inputs should not scan session entries");
			},
			getBranch: () => {
				throw new Error("thinking inputs should not scan session branch");
			},
		},
	} as unknown as ExtensionContext,
	"high",
);
assert.deepEqual(
	cheapThinkingInputs,
	{
		model: { id: "cheap-model", provider: "cheap-provider", contextWindow: 123000 },
		thinkingLevel: "high",
		availableProviderCount: 2,
	},
	"thinkingInputsFromContext should read only cheap model/thinking/provider facts",
);

const narrowLifecycleInputs = lifecycleInputsFromContext(
	{
		cwd: "/fallback-lifecycle",
		model: { id: "lifecycle-model", provider: "lifecycle-provider", contextWindow: 456000 },
		modelRegistry: {
			getAvailable: () => [{ provider: "lifecycle-provider" }, { provider: "other-provider" }, { provider: "" }],
		},
		getContextUsage: () => ({ tokens: 456, contextWindow: 456000, percent: 0.1 }),
		sessionManager: {
			getCwd: () => "/workspace-lifecycle",
			getEntries: () => {
				throw new Error("lifecycle inputs should not scan session entries");
			},
			getBranch: () => {
				throw new Error("lifecycle inputs should not scan session branch");
			},
		},
	} as unknown as ExtensionContext,
	"medium",
);
assert.deepEqual(
	narrowLifecycleInputs,
	{
		cwd: "/workspace-lifecycle",
		model: { id: "lifecycle-model", provider: "lifecycle-provider", contextWindow: 456000 },
		thinkingLevel: "medium",
		availableProviderCount: 2,
		contextUsage: { tokens: 456, contextWindow: 456000, percent: 0.1 },
		runtime: { autoCompactEnabled: true },
	},
	"lifecycleInputsFromContext should read workspace/model/thinking/provider/context/runtime facts without entries or branch scans",
);

const branchlessCompactInputs = compactInputsFromContext(
	{
		cwd: "/fallback-compact",
		model: { id: "compact-model", provider: "compact-provider", contextWindow: 789000 },
		modelRegistry: {
			getAvailable: () => [{ provider: "compact-provider" }, { provider: "other-provider" }],
		},
		getContextUsage: () => ({ tokens: 789, contextWindow: 789000, percent: 0.1 }),
		sessionManager: {
			getCwd: () => "/workspace-compact",
			getEntries: () => [message("assistant", { usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: { total: 0.75 } } })],
			getBranch: () => {
				throw new Error("compact inputs should not scan session branch");
			},
		},
	} as unknown as ExtensionContext,
	"low",
);
assert.deepEqual(
	branchlessCompactInputs,
	{
		cwd: "/workspace-compact",
		model: { id: "compact-model", provider: "compact-provider", contextWindow: 789000 },
		thinkingLevel: "low",
		availableProviderCount: 2,
		contextUsage: { tokens: 789, contextWindow: 789000, percent: 0.1 },
		usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.75 },
		runtime: { autoCompactEnabled: true },
	},
	"compactInputsFromContext should read compact usage/workspace/model/context without branch scans",
);

assert.deepEqual(
	usageTotalsFromAssistantMessage(message("user", { usage: { input: 100, output: 200, cacheRead: 300, cacheWrite: 400, cost: { total: 999 } } }).message ?? {}),
	{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	"usageTotalsFromAssistantMessage should ignore non-assistant messages",
);
assert.deepEqual(
	usageTotalsFromAssistantMessage(message("assistant", { usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.25, input: 10 } } }).message ?? {}),
	{ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.25 },
	"usageTotalsFromAssistantMessage should prefer finite cost.total over cost components",
);
assert.deepEqual(
	usageTotalsFromAssistantMessage(message("assistant", { usage: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4 } } }).message ?? {}),
	{ input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cost: 1 },
	"usageTotalsFromAssistantMessage should fall back to cost components when cost.total is absent",
);
assert.deepEqual(
	usageTotalsFromAssistantMessage(message("assistant").message ?? {}),
	{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	"usageTotalsFromAssistantMessage should default missing usage to zero",
);

assert.deepEqual(
	usageTotalsFromEntries([
		message("user", { usage: { input: 100, output: 200, cacheRead: 300, cacheWrite: 400, cost: { total: 999 } } }),
		{ type: "tool", message: { role: "assistant", usage: { input: 100 } } } as StateSessionEntry,
		message("assistant", { usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.25, input: 10 } } }),
		message("assistant", { usage: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4 } } }),
		message("toolResult", { usage: { input: 2, output: 3, cost: { total: 0.5 } } }),
		{ type: "compaction", usage: { input: 4, output: 5, cost: { total: 0.75 } } },
		message("assistant"),
	]),
	{ input: 12, output: 16, cacheRead: 10, cacheWrite: 12, cost: 2.5 },
	"usage totals should match Pi footer accounting for assistant, nested tool, and compaction usage",
);

assert.deepEqual(
	stateInputsFromContext(
		fakeContext({
			entries: [message("assistant", { usage: { input: 2, output: 3, cost: { total: 0.5 } } })],
			branch: [compaction(), message("assistant", { usage: { totalTokens: 5 } })],
		}),
		"low",
	),
	{
		cwd: "/fallback",
		model: undefined,
		thinkingLevel: "low",
		contextUsage: undefined,
		usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
		runtime: { autoCompactEnabled: true },
		availableProviderCount: 1,
		unknownContextAfterLatestCompaction: false,
	},
	"stateInputsFromContext should combine cwd, thinking, usage totals, and compaction status",
);

assert.equal(hasUnknownContextAfterLatestCompaction([]), false, "no compaction should mean context is not unknown");
assert.equal(hasUnknownContextAfterLatestCompaction([message("assistant", { usage: { totalTokens: 0 } })]), false, "assistant without compaction should not mark context unknown");
assert.equal(hasUnknownContextAfterLatestCompaction([compaction()]), true, "compaction followed by no assistant should mark context unknown");
assert.equal(hasUnknownContextAfterLatestCompaction([compaction(), message("user")]), true, "user messages after compaction should not satisfy context usage recovery");
assert.equal(hasUnknownContextAfterLatestCompaction([compaction(), message("assistant", { usage: { totalTokens: 1 } })]), false, "positive assistant totalTokens after compaction should clear unknown context");
assert.equal(hasUnknownContextAfterLatestCompaction([compaction(), message("assistant", { usage: { totalTokens: 0, input: 10, output: 10 } })]), true, "finite totalTokens should take precedence even when component tokens are positive");
assert.equal(hasUnknownContextAfterLatestCompaction([compaction(), message("assistant", { usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } })]), false, "positive component token sum should clear unknown context when totalTokens is absent");
assert.equal(hasUnknownContextAfterLatestCompaction([compaction(), message("assistant", { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })]), true, "zero component token sum should keep context unknown");
assert.equal(hasUnknownContextAfterLatestCompaction([compaction(), message("assistant")]), true, "missing assistant usage after compaction should keep context unknown");
assert.equal(hasUnknownContextAfterLatestCompaction([compaction(), message("assistant", { usage: { totalTokens: 100 }, stopReason: "aborted" })]), true, "aborted assistant after compaction should keep context unknown");
assert.equal(hasUnknownContextAfterLatestCompaction([compaction(), message("assistant", { usage: { totalTokens: 100 }, stopReason: "error" })]), true, "errored assistant after compaction should keep context unknown");
assert.equal(
	hasUnknownContextAfterLatestCompaction([
		message("assistant", { usage: { totalTokens: 100 } }),
		compaction(),
		message("user"),
	]),
	true,
	"assistants before the latest compaction should be ignored",
);
assert.equal(
	hasUnknownContextAfterLatestCompaction([
		compaction(),
		message("assistant", { usage: { totalTokens: 0 } }),
		compaction(),
		message("user"),
	]),
	true,
	"only assistants after the latest compaction should count",
);
assert.equal(
	hasUnknownContextAfterLatestCompaction([
		compaction(),
		message("assistant", { usage: { totalTokens: 0 } }),
		message("assistant", { usage: { totalTokens: 8 } }),
	]),
	false,
	"latest assistant after compaction should decide the unknown-context status",
);

console.log("✓ state input extraction checks passed");
