import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { aggregate, dimensionKey, sumRows } from "./aggregate.ts";
import { DIMENSIONS, WINDOWS } from "./enums.ts";
import { fmtBar, fmtCompactTokens, fmtCost, fmtNum, padRight } from "./format.ts";
import { windowDisplayLabel, type LedgerWindowMode } from "./time.ts";
import type { AggRow, BudgetStatus, Dimension, UsageRecord, WindowKey } from "./types.ts";

export interface DashboardData {
	records: UsageRecord[];
	budgets: BudgetStatus[];
}

export interface ThemePort {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

interface DrillFilter {
	dim: Dimension;
	key: string;
	label: string;
}

const PAGE = 16;
const MARKER = 2;
const MIN_NAME = 12;
const METRIC_HEADERS = ["tokens", "in", "out", "cache r", "cache w", "cost"] as const;

interface DashLayout {
	nameW: number;
	barW: number;
	numW: number;
	gap: number;
	showBar: boolean;
}

function metricBlockWidth(numW: number, gap: number): number {
	return METRIC_HEADERS.length * numW + gap * METRIC_HEADERS.length;
}

function barBlockWidth(barW: number, gap: number, showBar: boolean): number {
	return showBar ? barW + gap : 0;
}

function fixedWidth(layout: Pick<DashLayout, "barW" | "numW" | "gap" | "showBar">): number {
	return MARKER + barBlockWidth(layout.barW, layout.gap, layout.showBar) + metricBlockWidth(layout.numW, layout.gap);
}

/** Fit name + optional bar + tokens/in/out/cache r/cache w/cost into `width` without clipping metrics. */
function dashLayout(width: number, maxLabel: number): DashLayout {
	const wantedName = Math.max(MIN_NAME, maxLabel + 2);
	const candidates: Array<Pick<DashLayout, "barW" | "numW" | "gap" | "showBar">> = [
		{ barW: 10, numW: 10, gap: 2, showBar: true },
		{ barW: 8, numW: 8, gap: 1, showBar: true },
		{ barW: 0, numW: 7, gap: 1, showBar: false },
	];
	for (const candidate of candidates) {
		const room = width - fixedWidth(candidate);
		if (room < MIN_NAME) continue;
		return { ...candidate, nameW: Math.min(wantedName, room) };
	}
	const fallback = { barW: 0, numW: 7, gap: 1, showBar: false as const };
	return { ...fallback, nameW: Math.max(8, width - fixedWidth(fallback)) };
}

export class Dashboard {
	private windowIdx = 0;
	private dimIdx = 0;
	private cursor = 0;
	private scroll = 0;
	private filters: DrillFilter[] = [];
	private cachedWidth = -1;
	private cachedLines: string[] = [];

	constructor(
		private data: DashboardData,
		private theme: ThemePort,
		initialWindow: WindowKey | null,
		private windowMode: LedgerWindowMode = "rolling",
	) {
		if (initialWindow) {
			const idx = WINDOWS.findIndex((window) => window.key === initialWindow);
			if (idx >= 0) this.windowIdx = idx;
		}
	}

	public onDone?: () => void;

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.onDone?.();
			return;
		}
		if (data >= "1" && data <= "6") {
			const idx = Number(data) - 1;
			if (idx < WINDOWS.length) {
				this.windowIdx = idx;
				this.resetView();
			}
			return;
		}
		if (data === "d" || data === "D") {
			this.dimIdx = (this.dimIdx + 1) % DIMENSIONS.length;
			this.resetView();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.drillDown();
			return;
		}
		if (matchesKey(data, Key.backspace) || data === "u" || data === "U") {
			if (this.filters.length > 0) {
				const popped = this.filters.pop()!;
				this.dimIdx = DIMENSIONS.findIndex((dim) => dim.key === popped.dim);
				this.resetView();
			}
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.moveCursor(1);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.moveCursor(-1);
		}
	}

	private moveCursor(delta: number): void {
		const rows = this.computeRows();
		if (rows.length === 0) return;
		this.cursor = Math.max(0, Math.min(rows.length - 1, this.cursor + delta));
		if (this.cursor < this.scroll) this.scroll = this.cursor;
		else if (this.cursor >= this.scroll + PAGE) this.scroll = this.cursor - PAGE + 1;
		this.invalidate();
	}

	private drillDown(): void {
		const rows = this.computeRows();
		const row = rows[this.cursor];
		if (!row) return;
		const dim = DIMENSIONS[this.dimIdx];
		this.filters.push({ dim: dim.key, key: row.key, label: row.label });
		const order: Dimension[] = ["model", "project", "session"];
		const next = order[(order.indexOf(dim.key) + 1) % order.length];
		this.dimIdx = DIMENSIONS.findIndex((item) => item.key === next);
		this.resetView();
	}

	private resetView(): void {
		this.cursor = 0;
		this.scroll = 0;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = -1;
	}

	private computeRows(): AggRow[] {
		const win = WINDOWS[this.windowIdx];
		const dim = DIMENSIONS[this.dimIdx];
		let recs = this.data.records;
		for (const filter of this.filters) recs = recs.filter((record) => dimensionKey(filter.dim, record).key === filter.key);
		return aggregate(recs, win.key, dim.key, new Date(), this.windowMode);
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines.length) return this.cachedLines;
		const t = this.theme;
		const win = WINDOWS[this.windowIdx];
		const dim = DIMENSIONS[this.dimIdx];
		const rows = this.computeRows();
		const total = sumRows(rows);
		const lines: string[] = [];
		lines.push(t.fg("accent", t.bold(`pi-meter — ${dim.label} usage`)));
		const crumb = this.filters.length > 0 ? this.filters.map((filter) => filter.label).join(" ▸ ") : "—";
		lines.push(t.fg("muted", `window: ${windowDisplayLabel(win.key, this.windowMode)}  •  ${fmtNum(rows.length)} ${dim.label.toLowerCase()}(s)  •  filter: ${crumb}`));
		lines.push("");
		if (rows.length === 0) {
			lines.push(t.fg("dim", "No usage recorded in this window" + (this.filters.length ? " for this filter" : "") + "."));
			lines.push("");
			lines.push(t.fg("dim", this.helpLine()));
			return this.cache(width, lines);
		}

		const costCell = (row: AggRow): string => (row.costKnown ? fmtCost(row.cost) : "n/a");
		const maxLabel = Math.max(visibleWidth(dim.label), ...rows.map((row) => visibleWidth(row.label)));
		const layout = dashLayout(width, maxLabel);
		const { nameW, barW, numW, gap, showBar } = layout;
		const gapStr = " ".repeat(gap);
		const ruleW = Math.min(width, MARKER + nameW + barBlockWidth(barW, gap, showBar) + metricBlockWidth(numW, gap));
		const joinRow = (name: string, bar: string | undefined, metrics: string[]): string => {
			const parts = [name];
			if (showBar && bar !== undefined) parts.push(bar);
			parts.push(...metrics);
			return parts.join(gapStr);
		};
		const metricTexts = (values: readonly string[], paint: (text: string, index: number) => string): string[] =>
			values.map((value, index) => padRight(paint(value, index), numW));
		const header =
			joinRow(
				padRight(`  ${t.fg("dim", dim.label)}`, MARKER + nameW),
				showBar ? padRight(t.fg("dim", "usage"), barW) : undefined,
				metricTexts(METRIC_HEADERS, (text) => t.fg("dim", text)),
			);
		lines.push(truncateToWidth(header, width));
		lines.push(t.fg("border", "─".repeat(ruleW)));

		const maxTokens = rows[0]?.tokens ?? 1;
		const pageStart = this.scroll;
		const pageEnd = Math.min(rows.length, pageStart + PAGE);
		const rowMetrics = (row: AggRow): string[] => [
			fmtCompactTokens(row.tokens),
			fmtCompactTokens(row.input),
			fmtCompactTokens(row.output),
			fmtCompactTokens(row.cacheRead),
			fmtCompactTokens(row.cacheWrite),
			costCell(row),
		];
		for (let i = pageStart; i < pageEnd; i++) {
			const row = rows[i];
			if (!row) continue;
			const isCursor = i === this.cursor;
			const ratio = maxTokens > 0 ? row.tokens / maxTokens : 0;
			const nameRaw = truncateToWidth(row.label, nameW, "");
			const name = padRight((isCursor ? "▶ " : "  ") + (isCursor ? t.fg("accent", t.bold(nameRaw)) : nameRaw), MARKER + nameW);
			const line = joinRow(
				name,
				showBar ? t.fg("accent", padRight(fmtBar(ratio, barW), barW)) : undefined,
				metricTexts(rowMetrics(row), (text, index) => {
					if (index < 3) return t.fg("text", text);
					if (index < 5) return t.fg("muted", text);
					return t.fg(row.costKnown ? "success" : "dim", text);
				}),
			);
			lines.push(truncateToWidth(line, width));
		}

		lines.push(t.fg("border", "─".repeat(ruleW)));
		const totalLine = joinRow(
			padRight("  " + t.fg("accent", t.bold("Total")), MARKER + nameW),
			showBar ? " ".repeat(barW) : undefined,
			metricTexts(rowMetrics(total), (text) => t.fg("accent", text)),
		);
		lines.push(truncateToWidth(totalLine, width));
		if (rows.length > PAGE) lines.push(t.fg("dim", `   showing ${pageStart + 1}-${pageEnd} of ${rows.length}`));

		if (this.data.budgets.length > 0) {
			lines.push("");
			lines.push(t.fg("accent", t.bold("Local budgets")));
			for (const status of this.data.budgets) {
				const limit = status.limit;
				const metricTxt = limit.metric === "cost"
					? `$${status.current.toFixed(2)}/$${limit.max.toFixed(2)}`
					: `${fmtCompactTokens(status.current)}/${fmtCompactTokens(limit.max)}`;
				const color = status.exceeded ? "error" : status.warning ? "warning" : "dim";
				lines.push(t.fg(color, `  ${limit.scope} ${limit.period} ${limit.metric}: ${metricTxt} (${status.pct.toFixed(0)}%)`));
			}
		}

		lines.push("");
		lines.push(t.fg("dim", this.helpLine()));
		return this.cache(width, lines);
	}

	private cache(width: number, lines: string[]): string[] {
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private helpLine(): string {
		const drill = this.filters.length > 0 ? "  [u] back" : "";
		return `[1-6] window  [d] dimension  [enter] drill in${drill}  [↑↓] move  [q] close`;
	}
}
