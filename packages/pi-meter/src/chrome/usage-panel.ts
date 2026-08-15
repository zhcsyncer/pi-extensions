import { displayedPercent, formatResetLong, quotaTone } from "./format.ts";
import type { QuotaPolarity } from "../config.ts";
import type { QuotaSnapshot, QuotaWindow } from "../quota/types.ts";

function bar(usedPercent: number, polarity: QuotaPolarity, width = 10): string {
	const ratio = displayedPercent(usedPercent, polarity) / 100;
	const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width);
	return `[${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}]`;
}

function formatWindow(window: QuotaWindow, polarity: QuotaPolarity, now: Date): string {
	const percent = Math.round(displayedPercent(window.usedPercent, polarity));
	const reset = formatResetLong(window.resetsAt, now);
	const parts = [`  ${window.label.padEnd(22)}`, bar(window.usedPercent, polarity), `${String(percent).padStart(3)}%`];
	if (reset) parts.push(`· ${reset}`);
	if (window.note) parts.push(`· ${window.note}`);
	return parts.join(" ");
}

export function renderUsagePanel(
	snapshots: readonly QuotaSnapshot[],
	polarity: QuotaPolarity,
	now: Date = new Date(),
): string {
	const blocks: string[] = [];
	for (const snapshot of snapshots) {
		const stale = snapshot.stale ? " (stale)" : "";
		if (!snapshot.ok) {
			blocks.push(`${snapshot.title}${stale}\n  ${snapshot.error ?? "unavailable"}`);
			continue;
		}
		if (snapshot.windows.length === 0) {
			blocks.push(`${snapshot.title}${stale}\n  (no usage data reported)`);
			continue;
		}
		const rows = snapshot.windows.map((window) => formatWindow(window, polarity, now));
		blocks.push([`${snapshot.title}${stale}`, ...rows].join("\n"));
	}
	if (blocks.length === 0) return "No subscription snapshots yet.";
	return blocks.join("\n\n");
}

export function usageSeverity(snapshots: readonly QuotaSnapshot[], polarity: QuotaPolarity): "info" | "warning" {
	for (const snapshot of snapshots) {
		if (!snapshot.ok) return "warning";
		for (const window of snapshot.windows) {
			const tone = quotaTone(window.usedPercent);
			if (tone !== "muted") return "warning";
		}
	}
	void polarity;
	return "info";
}
