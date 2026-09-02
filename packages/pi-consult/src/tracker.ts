import { canSpendBudget } from "./budget.ts";
import { emptyFingerprintState, loopGateReason, recordToolEvent, type FingerprintState } from "./fingerprint.ts";
import { CONSULT_TOOL_NAME } from "./messages.ts";
import type { ConsultBudget, ConsultTrigger } from "./types.ts";

export interface LoopGateDecision {
	fire: boolean;
	reason?: "same" | "error";
}

export class ConsultTracker {
	fingerprint: FingerprintState = emptyFingerprintState();
	pendingArgs = new Map<string, { name: string; args: unknown }>();
	lock = false;
	pendingTrigger: ConsultTrigger | undefined;
	turnCount = 0;
	sessionCount = 0;

	onSessionStart(): void {
		this.onUserTurn();
		this.sessionCount = 0;
	}

	onUserTurn(): void {
		this.fingerprint = emptyFingerprintState();
		this.pendingArgs.clear();
		this.lock = false;
		this.pendingTrigger = undefined;
		this.turnCount = 0;
	}

	onToolStart(toolCallId: string, name: string, args: unknown): void {
		if (name === CONSULT_TOOL_NAME) return;
		this.pendingArgs.set(toolCallId, { name, args });
	}

	onToolEnd(toolCallId: string, name: string, isError: boolean, args?: unknown): void {
		if (name === CONSULT_TOOL_NAME) return;
		const pending = this.pendingArgs.get(toolCallId);
		this.pendingArgs.delete(toolCallId);
		this.fingerprint = recordToolEvent(this.fingerprint, {
			name,
			input: pending?.args ?? args ?? null,
			isError,
		});
	}

	consumeTrigger(): ConsultTrigger {
		const trigger = this.pendingTrigger ?? "pull";
		this.pendingTrigger = undefined;
		this.lock = false;
		return trigger;
	}

	recordConsult(): void {
		this.turnCount += 1;
		this.sessionCount += 1;
	}

	evaluateLoop(n: number, budget: ConsultBudget): LoopGateDecision {
		if (this.lock) return { fire: false };
		if (!canSpendBudget(budget, this.turnCount, this.sessionCount)) return { fire: false };
		const reason = loopGateReason(this.fingerprint, n);
		if (!reason) return { fire: false };
		return { fire: true, reason };
	}

	markLoopFired(): void {
		this.lock = true;
		this.pendingTrigger = "loop";
	}
}
