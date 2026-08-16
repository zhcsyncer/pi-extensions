import type { Dimension, WindowKey } from "./types.ts";

export const DIMENSIONS: { key: Dimension; label: string }[] = [
	{ key: "model", label: "Model" },
	{ key: "session", label: "Session" },
	{ key: "project", label: "Project" },
];

export const WINDOWS: { key: WindowKey; label: string }[] = [
	{ key: "today", label: "Today" },
	{ key: "week", label: "This Week" },
	{ key: "month", label: "This Month" },
	{ key: "6months", label: "Last 6 Months" },
	{ key: "year", label: "This Year" },
	{ key: "all", label: "All Time" },
];
