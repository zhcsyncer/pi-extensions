import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ConsultEvent, PanelMember } from "./types.ts";

export interface ConsultStatusData {
	panel: PanelMember[];
	fanout: boolean;
	watchdog: number;
	budgetRemaining: string;
	recent: ConsultEvent[];
	recentError?: string;
}

export interface ConsultDashboardTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

function compactTokens(value: number): string {
	if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1)}B`;
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
	return String(value);
}

function eventTime(ts: string): string {
	const match = ts.match(/^\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2})/);
	return match ? `${match[1]} ${match[2]}` : ts.slice(0, 11);
}

function verdictColor(verdict: ConsultEvent["verdict"]): string {
	if (verdict === "confirm") return "success";
	if (verdict === "revise" || verdict === "split") return "warning";
	if (verdict === "stop" || verdict === "error") return "error";
	return "accent";
}

function triggerLabel(trigger: ConsultEvent["trigger"]): string {
	return trigger === "onDemand" ? "on-demand" : "watchdog";
}

function adoptionLabel(event: ConsultEvent): { text: string; color: string } {
	if (event.adoptionEffect === "changed") return { text: "changed", color: "success" };
	if (event.adoptionEffect === "confirmed") return { text: "confirmed", color: "accent" };
	if (event.adoptionEffect === "rejected" || event.adopted === false) return { text: "rejected", color: "muted" };
	if (event.adopted === true) return { text: "adopted", color: "success" };
	return { text: "pending", color: "dim" };
}

export class ConsultStatusDashboard {
	private cachedWidth = -1;
	private cachedLines: string[] = [];
	public onDone?: () => void;

	constructor(
		private readonly data: ConsultStatusData,
		private readonly theme: ConsultDashboardTheme,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || data === "Q") this.onDone?.();
	}

	invalidate(): void {
		this.cachedWidth = -1;
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines.length > 0) return this.cachedLines;
		const t = this.theme;
		const lines: string[] = [];
		const push = (line = "") => lines.push(truncateToWidth(line, width));

		push(t.fg("accent", t.bold("pi-consult — status")));
		push("");
		push(t.fg("accent", t.bold("Panel")));
		if (this.data.panel.length === 0) {
			push(t.fg("dim", "  No advisor configured (consult is unloaded)."));
		} else {
			for (let index = 0; index < this.data.panel.length; index++) {
				const member = this.data.panel[index];
				if (!member) continue;
				const effort = member.effort ? `  ${t.fg("muted", `effort ${member.effort}`)}` : "";
				push(`  ${t.fg("accent", String(index + 1))}  ${member.model}${effort}`);
			}
		}
		push(
			t.fg(
				"muted",
				`  fanout ${this.data.fanout ? "on" : "off"}  •  watchdog ${this.data.watchdog > 0 ? this.data.watchdog : "off"}`,
			),
		);

		push("");
		push(t.fg("accent", t.bold("Budget remaining")));
		push(`  ${this.data.budgetRemaining}`);

		push("");
		push(t.fg("accent", t.bold("Recent consultations")));
		if (this.data.recentError) {
			push(t.fg("error", `  ${this.data.recentError}`));
		} else if (this.data.recent.length === 0) {
			push(t.fg("dim", "  No consult events yet."));
		} else {
			for (const event of [...this.data.recent].reverse()) {
				const adoption = adoptionLabel(event);
				const input = event.tokensIn + event.cacheRead + event.cacheWrite;
				const total = input + event.tokensOut;
				const metrics = [
					triggerLabel(event.trigger),
					`in ${compactTokens(input)}`,
					`out ${compactTokens(event.tokensOut)}`,
					`total ${compactTokens(total)}`,
				];
				push(
					`  ${t.fg("dim", eventTime(event.ts))}  ${t.fg(verdictColor(event.verdict), event.verdict)}  ${t.fg(adoption.color, adoption.text)}`,
				);
				push(t.fg("muted", `    ${metrics.join("  •  ")}`));
			}
		}

		push("");
		push(t.fg("dim", "[q/esc] close"));
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}
