import { canSpendBudget } from "./budget.ts";
import { emptyFingerprintState, recordToolEvent, type FingerprintState, watchdogReason } from "./fingerprint.ts";
import { CONSULT_TOOL_NAME } from "./messages.ts";
import type { ConsultBudget, ConsultTrigger } from "./types.ts";

export interface WatchdogDecision {
	fire: boolean;
	reason?: "same" | "error";
}

export class ConsultTracker {
	fingerprint: FingerprintState = emptyFingerprintState();
	pendingArgs = new Map<string, { name: string; args: unknown }>();
	lock = false;
	pendingTrigger: ConsultTrigger | undefined;
	runCount = 0;
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
		this.runCount = 0;
	}

	onToolStart(toolCallId: string, name: string, args: unknown): void {
		if (name === CONSULT_TOOL_NAME) return;
		this.pendingArgs.set(toolCallId, { name, args });
	}

	onToolEnd(toolCallId: string, name: string, isError: boolean, args?: unknown): void {
		if (name === CONSULT_TOOL_NAME) {
			this.fingerprint = emptyFingerprintState();
			this.lock = false;
			this.pendingTrigger = undefined;
			return;
		}
		const pending = this.pendingArgs.get(toolCallId);
		this.pendingArgs.delete(toolCallId);
		this.fingerprint = recordToolEvent(this.fingerprint, {
			name,
			input: pending?.args ?? args ?? null,
			isError,
		});
	}

	consumeTrigger(): ConsultTrigger {
		const trigger = this.pendingTrigger ?? "onDemand";
		this.pendingTrigger = undefined;
		return trigger;
	}

	recordConsult(): void {
		this.runCount += 1;
		this.sessionCount += 1;
	}

	evaluateWatchdog(n: number, budget: ConsultBudget): WatchdogDecision {
		if (this.lock) return { fire: false };
		if (!canSpendBudget(budget, this.runCount, this.sessionCount)) return { fire: false };
		const reason = watchdogReason(this.fingerprint, n);
		if (!reason) return { fire: false };
		return { fire: true, reason };
	}

	markWatchdogFired(): void {
		this.lock = true;
		this.pendingTrigger = "watchdog";
	}
}
