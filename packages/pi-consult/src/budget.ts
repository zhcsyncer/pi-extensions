import { ERR_BUDGET_SESSION, ERR_BUDGET_TURN } from "./messages.ts";
import type { ConsultBudget } from "./types.ts";

export function canSpendBudget(budget: ConsultBudget, turnCount: number, sessionCount: number): boolean {
	if (budget.perTurn > 0 && turnCount >= budget.perTurn) return false;
	if (budget.perSession > 0 && sessionCount >= budget.perSession) return false;
	return true;
}

export function budgetBlockReason(budget: ConsultBudget, turnCount: number, sessionCount: number): string | undefined {
	if (budget.perTurn > 0 && turnCount >= budget.perTurn) return ERR_BUDGET_TURN;
	if (budget.perSession > 0 && sessionCount >= budget.perSession) return ERR_BUDGET_SESSION;
	return undefined;
}

export function formatBudgetRemaining(budget: ConsultBudget, turnCount: number, sessionCount: number): string {
	const turn = budget.perTurn > 0 ? `${Math.max(0, budget.perTurn - turnCount)}/${budget.perTurn} turn` : "turn unlimited";
	const session =
		budget.perSession > 0 ? `${Math.max(0, budget.perSession - sessionCount)}/${budget.perSession} session` : "session unlimited";
	return `${turn}, ${session}`;
}
