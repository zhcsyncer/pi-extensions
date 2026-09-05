import { estimateTokens } from "@earendil-works/pi-coding-agent";

/** Missing tokens mean unavailable, not zero or a partial run total. */
export interface ContextGrowth {
	tokens?: number;
	estimated: boolean;
}

interface TurnMeasurement {
	groupId: string;
	id: string;
	model?: string;
	input?: number;
	output?: number;
	calls: Map<string, string>;
	results: Map<string, number>;
	segment: number;
	comparisonBlocked?: boolean;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function finiteCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Pi splits cached input into separate buckets. Output is not request input. */
export function reportedContextInput(message: unknown): number | undefined {
	const source = record(message);
	if (!["stop", "toolUse", "length"].includes(String(source.stopReason))) return undefined;
	const usage = record(source.usage);
	const input = finiteCount(usage.input);
	const read = finiteCount(usage.cacheRead);
	const write = finiteCount(usage.cacheWrite);
	if (input === undefined || read === undefined || write === undefined) return undefined;
	const total = input + read + write;
	return Number.isFinite(total) && total > 0 ? total : undefined;
}

function messageEstimate(message: unknown): number | undefined {
	try {
		return finiteCount(estimateTokens(message as Parameters<typeof estimateTokens>[0]));
	} catch {
		return undefined;
	}
}

function modelIdentity(message: unknown): string | undefined {
	const source = record(message);
	if ([source.model, source.provider, source.api].some((value) => typeof value !== "string" || !value)) return undefined;
	return JSON.stringify([source.provider, source.api, source.model, source.responseModel]);
}

const UNAVAILABLE: ContextGrowth = { estimated: false };

/**
 * A numeric-only projection of finalized branch messages. A reported difference
 * is measured request growth, not isolated causal accounting for each action:
 * unrecorded prompt/provider transformations can also affect the next input.
 */
export class ContextGrowthLedger {
	private readonly turns = new Map<string, TurnMeasurement>();
	private readonly groups = new Map<string, string[]>();
	private readonly resultOwners = new Map<string, string>();
	private readonly discontinuousGroups = new Set<string>();
	private segment = 0;
	private lastTurnId?: string;

	reset(): void {
		this.turns.clear();
		this.groups.clear();
		this.resultOwners.clear();
		this.discontinuousGroups.clear();
		this.segment = 0;
		this.lastTurnId = undefined;
	}

	/** Never subtract across injected input, compaction, model or thinking changes. */
	breakChain(groupId?: string): void {
		this.segment++;
		if (groupId && this.groups.has(groupId)) this.discontinuousGroups.add(groupId);
	}

	recordAssistant(groupId: string, id: string, message: unknown): void {
		const source = record(message);
		const blocks = Array.isArray(source.content) ? source.content.map(record) : [];
		const existing = this.turns.get(id);
		const input = reportedContextInput(message);
		const finished = source.stopReason === "stop" || source.stopReason === "toolUse" || source.stopReason === "length";
		const output = !finished ? undefined
			: (input === undefined ? undefined : finiteCount(record(source.usage).output)) ?? messageEstimate(message);
		const calls = new Map(blocks.flatMap((block) => block.type === "toolCall" && typeof block.id === "string"
			? [[block.id, String(block.name ?? "")] as const] : []));
		const turn: TurnMeasurement = {
			id, groupId, input, output, calls,
			model: modelIdentity(message),
			segment: existing?.segment ?? this.segment,
			results: existing?.results ?? new Map(),
			comparisonBlocked: existing?.comparisonBlocked,
		};
		const ids = this.groups.get(groupId) ?? [];
		if (!ids.includes(id)) ids.push(id);
		this.groups.set(groupId, ids);
		this.turns.set(id, turn);
		this.lastTurnId = id;
		for (const call of calls.keys()) this.resultOwners.set(call, id);
		const previous = this.turns.get(ids[ids.indexOf(id) - 1] ?? "");
		if (previous && [...previous.calls.keys()].some((call) => !previous.results.has(call))) {
			previous.comparisonBlocked = true;
			this.discontinuousGroups.add(groupId);
		}
		if (input === undefined || (previous && (
			previous.segment !== turn.segment
			|| (previous.model && turn.model && previous.model !== turn.model)
		))) this.discontinuousGroups.add(groupId);
	}

	recordToolResult(message: unknown): void {
		const source = record(message);
		const id = typeof source.toolCallId === "string" ? this.resultOwners.get(source.toolCallId) : undefined;
		const turn = id ? this.turns.get(id) : undefined;
		if (!turn || turn.calls.get(String(source.toolCallId)) !== source.toolName) {
			if (turn) turn.comparisonBlocked = true;
			this.breakChain(this.turns.get(this.lastTurnId ?? "")?.groupId);
			return;
		}
		if (id !== this.lastTurnId) {
			turn.comparisonBlocked = true;
			this.breakChain(turn.groupId);
		}
		const tokens = messageEstimate(message);
		if (tokens !== undefined) turn.results.set(String(source.toolCallId), tokens);
	}

	getTurn(id: string): ContextGrowth | undefined {
		const turn = this.turns.get(id);
		if (!turn) return undefined;
		if (turn.output === undefined) return UNAVAILABLE;
		if ([...turn.calls.keys()].some((call) => !turn.results.has(call))) return undefined;
		const ids = this.groups.get(turn.groupId) ?? [];
		const next = this.turns.get(ids[ids.indexOf(id) + 1] ?? "");
		if (!turn.comparisonBlocked && next && next.input !== undefined && turn.input !== undefined
			&& turn.model !== undefined && turn.model === next.model && turn.segment === next.segment) {
			return { tokens: next.input - turn.input, estimated: false };
		}
		return {
			tokens: turn.output + [...turn.results.values()].reduce((sum, tokens) => sum + tokens, 0),
			estimated: true,
		};
	}

	getRun(groupId: string, expectedIds?: readonly string[]): ContextGrowth | undefined {
		const ids = expectedIds ?? this.groups.get(groupId);
		if (!ids?.length) return undefined;
		if (this.discontinuousGroups.has(groupId)) return UNAVAILABLE;
		let tokens = 0;
		let estimated = false;
		for (const id of ids) {
			const growth = this.getTurn(id);
			if (growth?.tokens === undefined) return UNAVAILABLE;
			tokens += growth.tokens;
			estimated ||= growth.estimated;
		}
		return { tokens, estimated };
	}
}

export function formatContextGrowth(growth: ContextGrowth | undefined): string | undefined {
	if (!growth) return undefined;
	if (growth.tokens === undefined || !Number.isFinite(growth.tokens)) return "ctx n/a";
	const absolute = Math.abs(growth.tokens);
	const count = absolute >= 1_000_000 ? `${(absolute / 1_000_000).toFixed(1)}m`
		: absolute >= 1000 ? `${(absolute / 1000).toFixed(1)}k` : String(Math.round(absolute));
	return `ctx ${growth.estimated ? "≈" : ""}${growth.tokens < 0 ? "-" : "+"}${count}`;
}
