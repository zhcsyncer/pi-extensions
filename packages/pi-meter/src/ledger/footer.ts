import { aggregate, sumToday } from "./aggregate.ts";
import { statusForLimit } from "./budget.ts";
import { fmtCompactCost, fmtCompactTokens, fmtCost } from "./format.ts";
import type { AggRow, BudgetLimit, UsageRecord } from "./types.ts";

export type FooterLocal = "today-spend" | "today-tokens" | "today-cost" | "budget" | "model" | "off";

export const FOOTER_LOCALS: { key: FooterLocal; label: string; description: string }[] = [
	{ key: "today-spend", label: "Today tokens + cost", description: "local tokens and USD spent today" },
	{ key: "today-tokens", label: "Today tokens", description: "local tokens used today" },
	{ key: "today-cost", label: "Today cost", description: "local USD spent today, if priced" },
	{ key: "budget", label: "Budget", description: "most urgent local budget" },
	{ key: "model", label: "Top model", description: "most-used model today" },
	{ key: "off", label: "Off", description: "hide local spend" },
];

/** @deprecated Use FooterLocal. Kept so old footer.json `full` still maps. */
export type FooterPreset = FooterLocal | "full";

export const FOOTER_PRESETS = FOOTER_LOCALS;

export interface FooterStats {
	today: AggRow;
	todayTurns: number;
	topModel: string | null;
	budget: { current: number; max: number; metric: "cost" | "tokens"; pct: number; warning: boolean } | null;
}

export function parseFooterLocal(value: unknown): FooterLocal | undefined {
	if (value === "full") return "today-spend";
	if (typeof value !== "string") return undefined;
	return FOOTER_LOCALS.some((item) => item.key === value) ? value as FooterLocal : undefined;
}

export function parseFooterPreset(value: unknown): FooterLocal | undefined {
	return parseFooterLocal(value);
}

export function computeFooterStats(records: readonly UsageRecord[], limits: readonly BudgetLimit[], now = new Date()): FooterStats {
	const today = sumToday(records, now);
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const top = aggregate(records, "today", "model", now)[0];
	let budget: FooterStats["budget"] = null;
	for (const limit of limits) {
		const status = statusForLimit(records, limit, now, "");
		if (!budget || status.pct > budget.pct) {
			budget = {
				current: status.current,
				max: limit.max,
				metric: limit.metric === "cost" ? "cost" : "tokens",
				pct: status.pct,
				warning: status.warning || status.exceeded,
			};
		}
	}
	return {
		today,
		todayTurns: records.filter((record) => record.ts >= start).length,
		topModel: top && top.tokens > 0 ? top.label : null,
		budget,
	};
}

export function renderLocalFooter(preset: FooterLocal, stats: FooterStats, tokenDetails: boolean): string | undefined {
	switch (preset) {
		case "off":
			return undefined;
		case "today-spend":
			return todayLine(stats.today, tokenDetails);
		case "today-tokens":
			return stats.today.tokens > 0 ? `today ${fmtCompactTokens(stats.today.tokens)}` : undefined;
		case "today-cost":
			return stats.today.costKnown && stats.today.cost > 0
				? `today ${fmtCompactCost(stats.today.cost) ?? fmtCost(stats.today.cost)}`
				: undefined;
		case "budget":
			return stats.budget ? budgetLine(stats.budget) : undefined;
		case "model":
			return stats.topModel ? `today ${shortModel(stats.topModel)} · ${stats.todayTurns} turns` : undefined;
	}
}

function todayLine(today: AggRow, details: boolean): string {
	if (details) {
		return `today ↑${fmtCompactTokens(today.input)} ↓${fmtCompactTokens(today.output)} hit ${fmtCompactTokens(today.cacheRead)}`;
	}
	const tokens = fmtCompactTokens(today.tokens);
	const cost = today.costKnown ? fmtCompactCost(today.cost) : undefined;
	return cost ? `today ${tokens} ${cost}` : `today ${tokens}`;
}

function budgetLine(budget: NonNullable<FooterStats["budget"]>): string {
	const current = budget.metric === "cost" ? fmtCost(budget.current) : fmtCompactTokens(budget.current);
	const max = budget.metric === "cost" ? fmtCost(budget.max) : fmtCompactTokens(budget.max);
	return `budget ${current}/${max} (${budget.pct.toFixed(0)}%)${budget.warning ? " !" : ""}`;
}

function shortModel(model: string): string {
	const slash = model.lastIndexOf("/");
	return slash >= 0 ? model.slice(slash + 1) : model;
}
