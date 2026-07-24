import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageTotals } from "./types.js";

export interface StateModelInputs {
	id?: string;
	provider?: string;
	contextWindow?: number;
	reasoning?: boolean;
}

export interface StateContextUsageInputs {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface StateRuntimeInputs {
	autoCompactEnabled: boolean;
}

export interface StateInputs {
	cwd: string;
	model?: StateModelInputs;
	thinkingLevel: string;
	contextUsage?: StateContextUsageInputs;
	usage: UsageTotals;
	runtime: StateRuntimeInputs;
	availableProviderCount: number;
	unknownContextAfterLatestCompaction: boolean;
}

export interface StateThinkingInputs {
	model?: StateModelInputs;
	thinkingLevel: string;
	availableProviderCount: number;
}

export interface StateLifecycleInputs extends StateThinkingInputs {
	cwd: string;
	contextUsage?: StateContextUsageInputs;
	runtime: StateRuntimeInputs;
}

export interface StateCompactInputs extends StateLifecycleInputs {
	usage: UsageTotals;
}

interface StateMessageCostInputs {
	total?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

interface StateMessageUsageInputs {
	totalTokens?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: StateMessageCostInputs;
}

export interface StateMessageInputs {
	role?: string;
	stopReason?: string;
	usage?: StateMessageUsageInputs;
}

interface ModelRegistryLike {
	getAvailable?(): readonly { provider?: unknown }[];
}

interface ProviderContext {
	modelRegistry?: ModelRegistryLike;
}

export interface StateSessionEntry {
	type?: string;
	message?: StateMessageInputs;
	usage?: StateMessageUsageInputs;
}

const EMPTY_USAGE_TOTALS: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

function usageCost(usage: StateMessageUsageInputs | undefined): number {
	const cost = usage?.cost;
	if (!cost) return 0;
	if (Number.isFinite(cost.total)) return cost.total ?? 0;
	return (cost.input ?? 0) + (cost.output ?? 0) + (cost.cacheRead ?? 0) + (cost.cacheWrite ?? 0);
}

function usageTotalsFromUsage(usage: StateMessageUsageInputs | undefined): UsageTotals {
	if (!usage) return { ...EMPTY_USAGE_TOTALS };
	return {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		cost: usageCost(usage),
	};
}

export function usageTotalsFromAssistantMessage(message: StateMessageInputs): UsageTotals {
	return message.role === "assistant" ? usageTotalsFromUsage(message.usage) : { ...EMPTY_USAGE_TOTALS };
}

export function usageTotalsFromSessionMessage(message: StateMessageInputs): UsageTotals {
	return message.role === "assistant" || message.role === "toolResult" ? usageTotalsFromUsage(message.usage) : { ...EMPTY_USAGE_TOTALS };
}

export function usageTotalsFromEntries(entries: readonly StateSessionEntry[]): UsageTotals {
	const totals: UsageTotals = { ...EMPTY_USAGE_TOTALS };
	for (const entry of entries) {
		let delta = EMPTY_USAGE_TOTALS;
		if (entry.type === "message" && entry.message) delta = usageTotalsFromSessionMessage(entry.message);
		else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) delta = usageTotalsFromUsage(entry.usage);
		totals.input += delta.input;
		totals.output += delta.output;
		totals.cacheRead += delta.cacheRead;
		totals.cacheWrite += delta.cacheWrite;
		totals.cost += delta.cost;
	}
	return totals;
}

function assistantContextTokens(message: StateMessageInputs): number {
	const usage = message.usage;
	if (!usage) return 0;
	if (Number.isFinite(usage.totalTokens)) return usage.totalTokens ?? 0;
	return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

export function assistantMessageHasKnownContextUsage(message: StateMessageInputs): boolean {
	if (message.role !== "assistant") return false;
	if (message.stopReason === "aborted" || message.stopReason === "error") return false;
	return assistantContextTokens(message) > 0;
}

export function hasUnknownContextAfterLatestCompaction(branch: readonly StateSessionEntry[]): boolean {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i]?.type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) return false;

	for (let i = branch.length - 1; i > compactionIndex; i--) {
		const entry = branch[i];
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const message = entry.message;
		if (message.stopReason === "aborted" || message.stopReason === "error") return true;
		return assistantContextTokens(message) <= 0;
	}

	return true;
}

function availableProviderCountFromContext(ctx: ExtensionContext): number {
	const registry = (ctx as ExtensionContext & ProviderContext).modelRegistry;
	const availableModels = registry?.getAvailable?.() ?? [];
	const providers = new Set<string>();
	for (const model of availableModels) {
		if (typeof model.provider === "string" && model.provider) providers.add(model.provider);
	}
	return Math.max(1, providers.size);
}

function modelInputsFromContext(ctx: ExtensionContext): StateModelInputs | undefined {
	const model = ctx.model;
	return model
		? {
				id: model.id,
				provider: model.provider,
				contextWindow: model.contextWindow,
				...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
			}
		: undefined;
}

function contextUsageInputsFromContext(ctx: ExtensionContext): StateContextUsageInputs | undefined {
	const contextUsage = ctx.getContextUsage();
	return contextUsage
		? {
				tokens: contextUsage.tokens,
				contextWindow: contextUsage.contextWindow,
				percent: contextUsage.percent,
			}
		: undefined;
}

function runtimeInputs(autoCompactEnabled: boolean): StateRuntimeInputs {
	return { autoCompactEnabled };
}

export function thinkingInputsFromContext(ctx: ExtensionContext, thinkingLevel: string): StateThinkingInputs {
	return {
		model: modelInputsFromContext(ctx),
		thinkingLevel,
		availableProviderCount: availableProviderCountFromContext(ctx),
	};
}

export function lifecycleInputsFromContext(ctx: ExtensionContext, thinkingLevel: string, autoCompactEnabled = true): StateLifecycleInputs {
	const cwd = ctx.sessionManager.getCwd() || ctx.cwd;
	return {
		cwd,
		...thinkingInputsFromContext(ctx, thinkingLevel),
		contextUsage: contextUsageInputsFromContext(ctx),
		runtime: runtimeInputs(autoCompactEnabled),
	};
}

export function compactInputsFromContext(ctx: ExtensionContext, thinkingLevel: string, autoCompactEnabled = true): StateCompactInputs {
	const lifecycle = lifecycleInputsFromContext(ctx, thinkingLevel, autoCompactEnabled);
	const entries = ctx.sessionManager.getEntries();
	return {
		...lifecycle,
		runtime: runtimeInputs(autoCompactEnabled),
		usage: usageTotalsFromEntries(entries),
	};
}

export function stateInputsFromContext(ctx: ExtensionContext, thinkingLevel: string, autoCompactEnabled = true): StateInputs {
	return {
		...compactInputsFromContext(ctx, thinkingLevel, autoCompactEnabled),
		unknownContextAfterLatestCompaction: hasUnknownContextAfterLatestCompaction(ctx.sessionManager.getBranch()),
	};
}
