import { Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { QuotaPolarity } from "../config.ts";
import type { QuotaSnapshot } from "../quota/types.ts";
import { renderUsagePanel } from "./usage-panel.ts";

export interface QuotaDashboardTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

export class QuotaDashboard {
	private cachedWidth = -1;
	private cachedLines: string[] = [];

	constructor(
		private snapshots: readonly QuotaSnapshot[],
		private polarity: QuotaPolarity,
		private theme: QuotaDashboardTheme,
		private now = new Date(),
	) {}

	public onDone?: () => void;

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || data === "Q") this.onDone?.();
	}

	invalidate(): void {
		this.cachedWidth = -1;
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines.length > 0) return this.cachedLines;
		const t = this.theme;
		const lines = [
			t.fg("accent", t.bold("pi-meter — subscription quota")),
			t.fg("muted", `display: ${this.polarity}`),
			"",
			...renderUsagePanel(this.snapshots, this.polarity, this.now)
				.split("\n")
				.map((line) => this.styleReportLine(line)),
			"",
			t.fg("dim", "[q] close"),
		];
		const safeWidth = Math.max(1, width);
		this.cachedWidth = width;
		this.cachedLines = lines.flatMap((line) => line ? wrapTextWithAnsi(line, safeWidth) : [""]);
		return this.cachedLines;
	}

	private styleReportLine(line: string): string {
		if (!line) return line;
		if (line.startsWith("Not signed in:")) return this.theme.fg("dim", line);
		if (line.startsWith("  ")) return this.theme.fg("text", line);
		return this.theme.fg("accent", this.theme.bold(line));
	}
}
