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
	private inferenceMs = 0;
	private inferenceStartedAtMs: number | null = null;
	private readonly activeTools = new Set<string>();
	private uiPromptActive = false;

	start(startedAtMs: number): ThroughputRunStateIntent {
		this.reset();
		this.startedAtMs = startedAtMs;
		return { kind: "clear-current-run" };
	}

	messageUpdate(eventType: string, nowMs: ThroughputClock): void {
		if (this.startedAtMs === null) return;
		if (eventType === "done" || eventType === "error") {
			this.messageEnd(nowMs);
			return;
		}
		// Start only on real progress, not request/block start notifications.
		// Thinking and writing share one interval: content-block boundaries do not stop it.
		if (eventType !== "thinking_delta" && eventType !== "text_delta" && eventType !== "toolcall_delta") return;
		if (this.activeTools.size > 0 || this.uiPromptActive || this.inferenceStartedAtMs !== null) return;
		this.inferenceStartedAtMs = nowMs();
	}

	messageEnd(nowMs: ThroughputClock): void {
		if (this.inferenceStartedAtMs === null) return;
		this.inferenceMs += Math.max(0, nowMs() - this.inferenceStartedAtMs);
		this.inferenceStartedAtMs = null;
	}

	toolExecutionStart(toolCallId: string, nowMs: ThroughputClock): void {
		if (this.startedAtMs === null) return;
		this.messageEnd(nowMs);
		this.activeTools.add(toolCallId);
	}

	toolExecutionEnd(toolCallId: string): void {
		this.activeTools.delete(toolCallId);
		// All tools finishing means requesting, not inference. Wait for the next delta.
	}

	uiPromptStart(nowMs: ThroughputClock): void {
		if (this.startedAtMs === null) return;
		this.messageEnd(nowMs);
		this.uiPromptActive = true;
	}

	uiPromptEnd(): void {
		this.uiPromptActive = false;
	}

	settle(nowMs: ThroughputClock): ThroughputRunStateIntent {
		return this.startedAtMs === null ? NONE_INTENT : this.finish(this.completedAssistantMessages, nowMs);
	}

	checkpoint(turnIndex: unknown, message: unknown, nowMs: ThroughputClock): ThroughputRunStateIntent {
		if (this.startedAtMs === null) return NONE_INTENT;

		const normalizedTurnIndex = finiteTurnIndex(turnIndex);
		if (normalizedTurnIndex !== undefined && this.seenTurnIndexes.has(normalizedTurnIndex)) return NONE_INTENT;
		if (!isAssistantMessage(message)) return NONE_INTENT;

		this.completedAssistantMessages.push(message);
		if (normalizedTurnIndex !== undefined) this.seenTurnIndexes.add(normalizedTurnIndex);

		const endedAtMs = nowMs();
		this.messageEnd(() => endedAtMs);
		const currentRun = calculateTurnThroughput({
			startedAtMs: this.startedAtMs,
			endedAtMs,
			inferenceMs: this.inferenceMs,
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
			this.messageEnd(() => endedAtMs);
			const lastTurn = Array.isArray(messages)
				? calculateTurnThroughput({ startedAtMs, endedAtMs, inferenceMs: this.inferenceMs, messages })
				: undefined;
			return lastTurn ? { kind: "set-last-turn-and-clear-current-run", lastTurn } : { kind: "clear-current-run" };
		} finally {
			this.reset();
		}
	}

	reset(): ThroughputRunStateIntent {
		this.startedAtMs = null;
		this.inferenceMs = 0;
		this.inferenceStartedAtMs = null;
		this.activeTools.clear();
		this.uiPromptActive = false;
		this.completedAssistantMessages = [];
		this.seenTurnIndexes.clear();
		return NONE_INTENT;
	}
}
