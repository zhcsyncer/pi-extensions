import { calculateTurnThroughput } from "./throughput.js";
import type { TurnThroughput } from "./types.js";

export type ThroughputClock = () => number;

export type ThroughputRunStateIntent =
	| { kind: "none" }
	| { kind: "set-current-run"; currentRun: TurnThroughput }
	| { kind: "clear-current-run" }
	| { kind: "set-last-turn-and-clear-current-run"; lastTurn: TurnThroughput };

const NONE_INTENT: ThroughputRunStateIntent = { kind: "none" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isAssistantMessage(value: unknown): boolean {
	return isRecord(value) && value.role === "assistant";
}

function finiteTurnIndex(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class ThroughputRunTracker {
	private startedAtMs: number | null = null;
	private completedAssistantMessages: unknown[] = [];
	private readonly seenTurnIndexes = new Set<number>();

	start(startedAtMs: number): ThroughputRunStateIntent {
		this.startedAtMs = startedAtMs;
		this.completedAssistantMessages = [];
		this.seenTurnIndexes.clear();
		return { kind: "clear-current-run" };
	}

	checkpoint(turnIndex: unknown, message: unknown, nowMs: ThroughputClock): ThroughputRunStateIntent {
		if (this.startedAtMs === null) return NONE_INTENT;

		const normalizedTurnIndex = finiteTurnIndex(turnIndex);
		if (normalizedTurnIndex !== undefined && this.seenTurnIndexes.has(normalizedTurnIndex)) return NONE_INTENT;
		if (!isAssistantMessage(message)) return NONE_INTENT;

		this.completedAssistantMessages.push(message);
		if (normalizedTurnIndex !== undefined) this.seenTurnIndexes.add(normalizedTurnIndex);

		const currentRun = calculateTurnThroughput({
			startedAtMs: this.startedAtMs,
			endedAtMs: nowMs(),
			messages: this.completedAssistantMessages,
		});
		return currentRun ? { kind: "set-current-run", currentRun } : { kind: "clear-current-run" };
	}

	finish(messages: unknown, nowMs: ThroughputClock): ThroughputRunStateIntent {
		const startedAtMs = this.startedAtMs;
		if (startedAtMs === null) {
			this.reset();
			return { kind: "clear-current-run" };
		}

		try {
			const endedAtMs = nowMs();
			const lastTurn = Array.isArray(messages)
				? calculateTurnThroughput({ startedAtMs, endedAtMs, messages })
				: undefined;
			return lastTurn ? { kind: "set-last-turn-and-clear-current-run", lastTurn } : { kind: "clear-current-run" };
		} finally {
			this.reset();
		}
	}

	reset(): ThroughputRunStateIntent {
		this.startedAtMs = null;
		this.completedAssistantMessages = [];
		this.seenTurnIndexes.clear();
		return NONE_INTENT;
	}
}
