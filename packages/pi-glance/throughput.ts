import type { TurnThroughput, TurnThroughputUsage } from "./types.js";

export interface CalculateTurnThroughputInput {
	startedAtMs: number;
	endedAtMs: number;
	messages: readonly unknown[];
}

interface AssistantLikeMessage {
	role: "assistant";
	stopReason?: unknown;
	usage?: unknown;
}

interface NormalizedUsageParts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isAssistantMessage(value: unknown): value is AssistantLikeMessage {
	return isRecord(value) && value.role === "assistant";
}

function normalizeNonNegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeUsage(value: unknown): NormalizedUsageParts {
	const usage = isRecord(value) ? value : {};
	const input = normalizeNonNegativeNumber(usage.input);
	const output = normalizeNonNegativeNumber(usage.output);
	const cacheRead = normalizeNonNegativeNumber(usage.cacheRead);
	const cacheWrite = normalizeNonNegativeNumber(usage.cacheWrite);
	const totalTokens = Object.hasOwn(usage, "totalTokens")
		? normalizeNonNegativeNumber(usage.totalTokens)
		: input + output + cacheRead + cacheWrite;
	return { input, output, cacheRead, cacheWrite, totalTokens };
}

function invalidStopReason(stopReason: unknown): boolean {
	return stopReason === "error" || stopReason === "aborted";
}

function emptyUsage(): TurnThroughputUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		assistantMessages: 0,
	};
}

export function calculateTurnThroughput(input: CalculateTurnThroughputInput): TurnThroughput | undefined {
	const elapsedMs = input.endedAtMs - input.startedAtMs;
	if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return undefined;

	const usage = emptyUsage();
	let lastAssistant: AssistantLikeMessage | undefined;

	for (const message of input.messages) {
		if (!isAssistantMessage(message)) continue;
		lastAssistant = message;
		usage.assistantMessages++;
		const parts = normalizeUsage(message.usage);
		usage.input += parts.input;
		usage.output += parts.output;
		usage.cacheRead += parts.cacheRead;
		usage.cacheWrite += parts.cacheWrite;
		usage.totalTokens += parts.totalTokens;
	}

	if (!lastAssistant) return undefined;
	if (invalidStopReason(lastAssistant.stopReason)) return undefined;
	if (usage.output <= 0) return undefined;

	return {
		startedAtMs: input.startedAtMs,
		endedAtMs: input.endedAtMs,
		elapsedMs,
		tokensPerSecond: usage.output / (elapsedMs / 1000),
		usage,
	};
}
