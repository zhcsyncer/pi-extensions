import { ERR_BUDGET_RUN, ERR_BUDGET_SESSION } from "./messages.ts";
import type { ConsultBudget } from "./types.ts";

export function canSpendBudget(budget: ConsultBudget, runCount: number, sessionCount: number): boolean {
	if (budget.perRun > 0 && runCount >= budget.perRun) return false;
	if (budget.perSession > 0 && sessionCount >= budget.perSession) return false;
	return true;
}

export function budgetBlockReason(budget: ConsultBudget, runCount: number, sessionCount: number): string | undefined {
	if (budget.perRun > 0 && runCount >= budget.perRun) return ERR_BUDGET_RUN;
	if (budget.perSession > 0 && sessionCount >= budget.perSession) return ERR_BUDGET_SESSION;
	return undefined;
}

export function formatBudgetRemaining(budget: ConsultBudget, runCount: number, sessionCount: number): string {
	const run = budget.perRun > 0 ? `${Math.max(0, budget.perRun - runCount)}/${budget.perRun} run` : "run unlimited";
	const session =
		budget.perSession > 0 ? `${Math.max(0, budget.perSession - sessionCount)}/${budget.perSession} session` : "session unlimited";
	return `${run}, ${session}`;
}
