export type WorkingPhase = "idle" | "requesting" | "thinking" | "responding" | "tool-use";

export interface WorkingAssistantMessage {
	readonly role?: unknown;
	readonly responseId?: unknown;
	readonly usage?: { readonly output?: unknown };
}

export interface WorkingIndicatorSnapshot {
	readonly active: boolean;
	readonly phase: WorkingPhase;
	readonly verb: string;
	readonly startedAtMs: number;
	readonly finalizedOutput: number;
	readonly partialOutput: number;
	readonly hasPartialEstimate: boolean;
	readonly lastProgressAtMs: number;
	readonly hasGenerationProgress: boolean;
	readonly thinkingEffort?: string;
	readonly tools: readonly { id: string; name: string }[];
}

const IDLE_SNAPSHOT: WorkingIndicatorSnapshot = {
	active: false,
	phase: "idle",
	verb: "",
	startedAtMs: 0,
	finalizedOutput: 0,
	partialOutput: 0,
	hasPartialEstimate: false,
	lastProgressAtMs: 0,
	hasGenerationProgress: false,
	tools: [],
};

function nonNegativeInteger(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function safeToolName(value: string): string {
	const cleaned = value.replace(/[\x00-\x1f\x7f]/g, "").trim();
	return cleaned || "tool";
}

export class WorkingIndicatorState {
	private snapshotValue: WorkingIndicatorSnapshot = IDLE_SNAPSHOT;
	private readonly finalizedResponseIds = new Set<string>();
	private readonly activeTools = new Map<string, string>();

	get snapshot(): WorkingIndicatorSnapshot {
		return this.snapshotValue;
	}

	agentStart(nowMs: number, verb: string, thinkingEffort?: string): void {
		if (!this.snapshotValue.active) {
			this.finalizedResponseIds.clear();
			this.activeTools.clear();
			this.snapshotValue = {
				active: true,
				phase: "requesting",
				verb,
				startedAtMs: nowMs,
				finalizedOutput: 0,
				partialOutput: 0,
				hasPartialEstimate: false,
				lastProgressAtMs: nowMs,
				hasGenerationProgress: false,
				...(thinkingEffort && thinkingEffort !== "off" ? { thinkingEffort } : {}),
				tools: [],
			};
			return;
		}
		this.patch({
			phase: "requesting",
			lastProgressAtMs: nowMs,
			hasGenerationProgress: false,
			...(thinkingEffort && thinkingEffort !== "off" ? { thinkingEffort } : { thinkingEffort: undefined }),
		});
	}

	turnStart(nowMs: number, thinkingEffort?: string): void {
		if (!this.snapshotValue.active) return;
		this.patch({
			phase: "requesting",
			lastProgressAtMs: nowMs,
			hasGenerationProgress: false,
			...(thinkingEffort && thinkingEffort !== "off" ? { thinkingEffort } : { thinkingEffort: undefined }),
		});
	}

	setThinkingEffort(thinkingEffort?: string): void {
		if (!this.snapshotValue.active) return;
		this.patch(thinkingEffort && thinkingEffort !== "off" ? { thinkingEffort } : { thinkingEffort: undefined });
	}

	messageUpdate(eventType: string, estimatedOutput: number, nowMs: number): void {
		if (!this.snapshotValue.active) return;
		let phase = this.snapshotValue.phase;
		if (eventType === "thinking_start" || eventType === "thinking_delta") phase = "thinking";
		else if (eventType === "text_start" || eventType === "text_delta" || eventType === "text_end") phase = "responding";
		const isGenerationDelta = eventType === "thinking_delta" || eventType === "text_delta" || eventType === "toolcall_delta";
		const hasGenerationProgress = phase === this.snapshotValue.phase
			? this.snapshotValue.hasGenerationProgress || isGenerationDelta
			: isGenerationDelta;
		this.patch({
			phase,
			partialOutput: nonNegativeInteger(estimatedOutput),
			hasPartialEstimate: true,
			lastProgressAtMs: nowMs,
			hasGenerationProgress,
		});
	}

	messageEnd(message: WorkingAssistantMessage, nowMs: number): void {
		if (!this.snapshotValue.active || message.role !== "assistant") return;
		const responseId = typeof message.responseId === "string" && message.responseId ? message.responseId : undefined;
		let finalizedOutput = this.snapshotValue.finalizedOutput;
		if (!responseId || !this.finalizedResponseIds.has(responseId)) {
			finalizedOutput += nonNegativeInteger(message.usage?.output);
			if (responseId) this.finalizedResponseIds.add(responseId);
		}
		this.patch({
			finalizedOutput,
			partialOutput: 0,
			hasPartialEstimate: false,
			lastProgressAtMs: nowMs,
		});
	}

	toolExecutionStart(toolCallId: string, toolName: string, nowMs: number): void {
		if (!this.snapshotValue.active) return;
		this.activeTools.set(toolCallId, safeToolName(toolName));
		this.patch({ phase: "tool-use", tools: this.tools(), lastProgressAtMs: nowMs, hasGenerationProgress: false });
	}

	toolExecutionEnd(toolCallId: string, nowMs: number): void {
		if (!this.snapshotValue.active) return;
		this.activeTools.delete(toolCallId);
		this.patch({
			phase: this.activeTools.size > 0 ? "tool-use" : "requesting",
			tools: this.tools(),
			lastProgressAtMs: nowMs,
			hasGenerationProgress: false,
		});
	}

	settle(): void {
		this.finalizedResponseIds.clear();
		this.activeTools.clear();
		this.snapshotValue = IDLE_SNAPSHOT;
	}

	private tools(): WorkingIndicatorSnapshot["tools"] {
		return [...this.activeTools].map(([id, name]) => ({ id, name }));
	}

	private patch(values: Partial<WorkingIndicatorSnapshot>): void {
		this.snapshotValue = { ...this.snapshotValue, ...values };
	}
}

export function workingOutputTokens(snapshot: WorkingIndicatorSnapshot): number {
	return snapshot.finalizedOutput + snapshot.partialOutput;
}

export function isWorkingStalled(snapshot: WorkingIndicatorSnapshot, nowMs: number, thresholdMs = 10_000): boolean {
	return (
		snapshot.active &&
		snapshot.phase === "responding" &&
		snapshot.hasGenerationProgress &&
		nowMs - snapshot.lastProgressAtMs >= thresholdMs
	);
}
