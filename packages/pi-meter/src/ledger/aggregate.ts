import { basename } from "node:path";
import type { AggRow, Dimension, UsageRecord, WindowKey } from "./types.ts";
import { windowStartMs, type LedgerWindowMode } from "./time.ts";

export function dimensionKey(dim: Dimension, rec: UsageRecord): { key: string; label: string } {
	switch (dim) {
		case "model":
			return { key: rec.model, label: rec.model };
		case "session":
			return { key: rec.sid, label: rec.sid };
		case "project":
			return { key: rec.cwd, label: basename(rec.cwd) || rec.cwd };
	}
}

function emptyRow(key: string, label: string): AggRow {
	return {
		key,
		label,
		tokens: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		costKnown: false,
		turns: 0,
	};
}

export function aggregate(
	records: readonly UsageRecord[],
	window: WindowKey,
	dim: Dimension,
	now: Date = new Date(),
	windowMode: LedgerWindowMode = "rolling",
): AggRow[] {
	const start = windowStartMs(window, now, windowMode);
	const map = new Map<string, AggRow>();
	for (const rec of records) {
		if (rec.ts < start) continue;
		const { key, label } = dimensionKey(dim, rec);
		let row = map.get(key);
		if (!row) {
			row = emptyRow(key, label);
			map.set(key, row);
		}
		row.tokens += rec.tot;
		row.input += rec.in;
		row.output += rec.out;
		row.cacheRead += rec.cR;
		row.cacheWrite += rec.cW;
		row.cost += rec.cost;
		if (rec.costKnown) row.costKnown = true;
		row.turns += 1;
	}
	return [...map.values()].sort((a, b) => b.tokens - a.tokens);
}

export function sumRows(rows: readonly AggRow[]): AggRow {
	return rows.reduce<AggRow>(
		(acc, row) => {
			acc.tokens += row.tokens;
			acc.input += row.input;
			acc.output += row.output;
			acc.cacheRead += row.cacheRead;
			acc.cacheWrite += row.cacheWrite;
			acc.cost += row.cost;
			if (row.costKnown) acc.costKnown = true;
			acc.turns += row.turns;
			return acc;
		},
		emptyRow("", ""),
	);
}

export function sumToday(
	records: readonly UsageRecord[],
	now: Date = new Date(),
	windowMode: LedgerWindowMode = "rolling",
): AggRow {
	return sumRows(aggregate(records, "today", "model", now, windowMode));
}
