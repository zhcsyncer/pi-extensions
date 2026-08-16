/** One captured assistant turn. Local ledger only — never stores remote quota. */
export interface UsageRecord {
	ts: number;
	sid: string;
	cwd: string;
	model: string;
	in: number;
	out: number;
	cR: number;
	cW: number;
	tot: number;
	cost: number;
	costKnown: boolean;
}

export type Dimension = "model" | "session" | "project";
export type WindowKey = "today" | "week" | "month" | "6months" | "year" | "all";

export interface AggRow {
	key: string;
	label: string;
	tokens: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	costKnown: boolean;
	turns: number;
}

export type Metric = "cost" | "tot" | "in" | "out";
export type Period = "day" | "week" | "month" | "year";
export type Scope = "global" | "session" | "project";

export interface BudgetLimit {
	scope: Scope;
	period: Period;
	metric: Metric;
	max: number;
	warn?: number;
	cwd?: string;
}

export interface BudgetsConfig {
	limits: BudgetLimit[];
}

export interface BudgetStatus {
	limit: BudgetLimit;
	current: number;
	pct: number;
	exceeded: boolean;
	warning: boolean;
}
