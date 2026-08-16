import type { BudgetLimit, BudgetStatus, Metric, UsageRecord } from "./types.ts";
import { periodKey } from "./time.ts";

export function metricValue(record: UsageRecord, metric: Metric): number {
	switch (metric) {
		case "cost":
			return record.cost;
		case "tot":
			return record.tot;
		case "in":
			return record.in;
		case "out":
			return record.out;
	}
}

export function budgetKey(limit: BudgetLimit, now: Date = new Date()): string {
	const pk = periodKey(now, limit.period);
	const scopeVal = limit.scope === "project" ? limit.cwd ?? "" : limit.scope === "session" ? "*" : "";
	return `${pk}|${limit.scope}|${scopeVal}|${limit.metric}`;
}

export function recordMatchesLimit(
	record: UsageRecord,
	limit: BudgetLimit,
	now: Date,
	sessionId: string,
): boolean {
	if (periodKey(new Date(record.ts), limit.period) !== periodKey(now, limit.period)) return false;
	if (limit.scope === "session" && record.sid !== sessionId) return false;
	if (limit.scope === "project" && record.cwd !== (limit.cwd ?? "__UNDEFINED__")) return false;
	return true;
}

export function sumForLimit(
	records: readonly UsageRecord[],
	limit: BudgetLimit,
	now: Date,
	sessionId: string,
): number {
	let sum = 0;
	for (const record of records) {
		if (recordMatchesLimit(record, limit, now, sessionId)) sum += metricValue(record, limit.metric);
	}
	return sum;
}

export function statusForLimit(
	records: readonly UsageRecord[],
	limit: BudgetLimit,
	now: Date,
	sessionId: string,
): BudgetStatus {
	const current = sumForLimit(records, limit, now, sessionId);
	const pct = limit.max > 0 ? (current / limit.max) * 100 : 0;
	const warnFrac = limit.warn ?? 0.8;
	return {
		limit,
		current,
		pct,
		exceeded: current >= limit.max,
		warning: current >= limit.max * warnFrac,
	};
}
