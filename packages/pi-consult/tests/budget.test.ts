import { describe, expect, it } from "vitest";
import { budgetBlockReason, canSpendBudget, formatBudgetRemaining } from "../src/budget.ts";
import { ERR_BUDGET_SESSION, ERR_BUDGET_TURN } from "../src/messages.ts";

describe("consult budget", () => {
	it("blocks at the per-turn cap", () => {
		const budget = { perTurn: 1, perSession: 8 };
		expect(canSpendBudget(budget, 0, 0)).toBe(true);
		expect(canSpendBudget(budget, 1, 0)).toBe(false);
		expect(budgetBlockReason(budget, 1, 0)).toBe(ERR_BUDGET_TURN);
	});

	it("blocks at the per-session cap even when the turn still has room", () => {
		const budget = { perTurn: 2, perSession: 8 };
		expect(canSpendBudget(budget, 0, 8)).toBe(false);
		expect(budgetBlockReason(budget, 0, 8)).toBe(ERR_BUDGET_SESSION);
	});

	it("treats 0 as unlimited", () => {
		expect(canSpendBudget({ perTurn: 0, perSession: 0 }, 99, 99)).toBe(true);
		expect(budgetBlockReason({ perTurn: 0, perSession: 0 }, 99, 99)).toBeUndefined();
	});

	it("formats remaining budget", () => {
		expect(formatBudgetRemaining({ perTurn: 1, perSession: 8 }, 0, 2)).toBe("1/1 turn, 6/8 session");
		expect(formatBudgetRemaining({ perTurn: 0, perSession: 0 }, 3, 3)).toBe("turn unlimited, session unlimited");
	});
});
