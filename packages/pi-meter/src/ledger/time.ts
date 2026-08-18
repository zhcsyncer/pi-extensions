import type { Period, WindowKey } from "./types.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;

export type LedgerWindowMode = "rolling" | "calendar";

export function parseLedgerWindowMode(value: unknown): LedgerWindowMode | undefined {
	return value === "rolling" || value === "calendar" ? value : undefined;
}

export function windowDisplayLabel(window: WindowKey, mode: LedgerWindowMode = "rolling"): string {
	if (mode === "rolling") {
		switch (window) {
			case "today":
				return "Last 24h";
			case "week":
				return "Last 7 days";
			case "month":
				return "Last 30 days";
			case "6months":
				return "Last 6 months";
			case "year":
				return "Last 365 days";
			case "all":
				return "All Time";
		}
	}
	switch (window) {
		case "today":
			return "Today";
		case "week":
			return "This Week";
		case "month":
			return "This Month";
		case "6months":
			return "Last 6 Months";
		case "year":
			return "This Year";
		case "all":
			return "All Time";
	}
}

export function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

export function windowStartMs(
	window: WindowKey,
	now: Date = new Date(),
	mode: LedgerWindowMode = "rolling",
): number {
	if (mode === "rolling") {
		switch (window) {
			case "today":
				return now.getTime() - DAY_MS;
			case "week":
				return now.getTime() - 7 * DAY_MS;
			case "month":
				return now.getTime() - 30 * DAY_MS;
			case "6months":
				return now.getTime() - 180 * DAY_MS;
			case "year":
				return now.getTime() - 365 * DAY_MS;
			case "all":
				return 0;
		}
	}
	switch (window) {
		case "today":
			return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		case "week": {
			const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			const day = (d.getDay() + 6) % 7;
			d.setDate(d.getDate() - day);
			return d.getTime();
		}
		case "month":
			return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
		case "6months":
			return now.getTime() - 180 * DAY_MS;
		case "year":
			return new Date(now.getFullYear(), 0, 1).getTime();
		case "all":
			return 0;
	}
}

export function isoWeekKey(d: Date): string {
	const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
	const dayNum = (date.getUTCDay() + 6) % 7;
	date.setUTCDate(date.getUTCDate() - dayNum + 3);
	const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
	const week =
		1 +
		Math.round(
			((date.getTime() - firstThursday.getTime()) / DAY_MS - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
		);
	return `${date.getUTCFullYear()}-W${pad2(week)}`;
}

export function periodKey(d: Date, period: Period): string {
	switch (period) {
		case "day":
			return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
		case "week":
			return isoWeekKey(d);
		case "month":
			return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
		case "year":
			return `${d.getFullYear()}`;
	}
}

export function parseWindowArg(arg: string): WindowKey | null {
	const map: Record<string, WindowKey> = {
		today: "today",
		day: "today",
		week: "week",
		month: "month",
		"6months": "6months",
		"6m": "6months",
		year: "year",
		all: "all",
	};
	return map[arg] ?? null;
}

export function sessionIdFrom(file: string | null | undefined): string {
	if (!file) return "ephemeral";
	const base = file.split(/[/\\]/).pop() ?? file;
	return base.replace(/\.jsonl?$/, "") || "ephemeral";
}
