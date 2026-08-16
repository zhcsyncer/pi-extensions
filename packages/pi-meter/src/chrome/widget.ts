import type { Theme } from "@earendil-works/pi-coding-agent";
import type { QuotaPolarity } from "../config.ts";
import { fmtCompactCost, fmtCompactTokens } from "../ledger/format.ts";
import type { AggRow } from "../ledger/types.ts";
import type { QuotaWindowView } from "../quota/policy.ts";
import { displayedPercent, formatResetShort, quotaTone, renderQuotaBar } from "./format.ts";

export const STATUS_KEY = "pi-meter";

export interface ChromeInput {
	today: AggRow;
	tokenDetails: boolean;
	quota?: QuotaWindowView;
	polarity: QuotaPolarity;
	now?: Date;
}

export function quotaWindowKind(window: { id: string; label: string }): string {
	const hay = `${window.id} ${window.label}`.toLowerCase();
	if (hay.includes("5h") || hay.includes("session") || hay.includes("five")) return "5h";
	if (hay.includes("week") || hay.includes("weekly")) return "week";
	if (hay.includes("month")) return "month";
	if (hay.includes("day") || hay.includes("daily")) return "day";
	const first = window.label.trim().split(/\s+/)[0];
	return first ? first.toLowerCase() : "quota";
}

function todayCaption(today: AggRow, details: boolean): string {
	if (details) {
		return `today ↑${fmtCompactTokens(today.input)} ↓${fmtCompactTokens(today.output)} hit ${fmtCompactTokens(today.cacheRead)}`;
	}
	const tokens = fmtCompactTokens(today.tokens);
	const cost = today.costKnown ? fmtCompactCost(today.cost) : undefined;
	return cost ? `today ${tokens} ${cost}` : `today ${tokens}`;
}

function quotaCaption(quota: QuotaWindowView, polarity: QuotaPolarity, now: Date): { label: string; value: string; tone: ReturnType<typeof quotaTone> } {
	const kind = quotaWindowKind(quota.window);
	const verb = polarity === "remaining" ? "left" : "used";
	const percent = Math.round(displayedPercent(quota.window.usedPercent, polarity));
	const reset = formatResetShort(quota.window.resetsAt, now);
	const stale = quota.stale ? " stale" : "";
	return {
		label: `${kind} ${verb}`,
		value: `${renderQuotaBar(quota.window.usedPercent, polarity)} ${percent}%${reset ? ` (${reset})` : ""}${stale}`,
		tone: quotaTone(quota.window.usedPercent),
	};
}

export function renderStatusText(input: ChromeInput, theme: Theme): string {
	const now = input.now ?? new Date();
	const today = theme.fg("muted", todayCaption(input.today, input.tokenDetails));
	if (!input.quota) return today;
	const quota = quotaCaption(input.quota, input.polarity, now);
	return [
		today,
		`${theme.fg("muted", quota.label)} ${theme.fg(quota.tone, quota.value)}`,
	].join(theme.fg("dim", " · "));
}

export function renderChromeLine(input: ChromeInput, _width: number, theme: Theme): string[] {
	return [renderStatusText(input, theme)];
}
