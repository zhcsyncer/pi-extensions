import { describe, expect, it } from "vitest";
import { budgetBlockReason, canSpendBudget, formatBudgetRemaining } from "../src/budget.ts";
import { ERR_BUDGET_RUN, ERR_BUDGET_SESSION } from "../src/messages.ts";

describe("consult budget", () => {
	it("blocks at the per-run cap", () => {
		const budget = { perRun: 3, perSession: 8 };
		expect(canSpendBudget(budget, 2, 2)).toBe(true);
		expect(canSpendBudget(budget, 3, 2)).toBe(false);
		expect(budgetBlockReason(budget, 3, 2)).toBe(ERR_BUDGET_RUN);
	});

	it("blocks at the per-session cap even when the run still has room", () => {
		const budget = { perRun: 3, perSession: 8 };
		expect(canSpendBudget(budget, 0, 8)).toBe(false);
		expect(budgetBlockReason(budget, 0, 8)).toBe(ERR_BUDGET_SESSION);
	});

	it("treats 0 as unlimited", () => {
		expect(canSpendBudget({ perRun: 0, perSession: 0 }, 99, 99)).toBe(true);
		expect(budgetBlockReason({ perRun: 0, perSession: 0 }, 99, 99)).toBeUndefined();
	});

	it("formats remaining budget", () => {
		expect(formatBudgetRemaining({ perRun: 3, perSession: 8 }, 1, 2)).toBe("2/3 run, 6/8 session");
		expect(formatBudgetRemaining({ perRun: 0, perSession: 0 }, 3, 3)).toBe("run unlimited, session unlimited");
	});
});
