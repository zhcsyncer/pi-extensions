import type { QuotaPolarity } from "../config.ts";
import { remainingPercent } from "../quota/policy.ts";

export const WARNING_REMAINING_PERCENT = 30;
export const ERROR_REMAINING_PERCENT = 15;

export type QuotaTone = "muted" | "warning" | "error";

export function displayedPercent(usedPercent: number, polarity: QuotaPolarity): number {
	const used = Math.min(100, Math.max(0, usedPercent));
	return polarity === "remaining" ? remainingPercent(used) : used;
}

export function quotaTone(usedPercent: number): QuotaTone {
	const remaining = remainingPercent(usedPercent);
	if (remaining <= ERROR_REMAINING_PERCENT) return "error";
	if (remaining <= WARNING_REMAINING_PERCENT) return "warning";
	return "muted";
}

export function renderQuotaBar(usedPercent: number, polarity: QuotaPolarity, width = 8): string {
	const ratio = displayedPercent(usedPercent, polarity) / 100;
	const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width);
	if (filled <= 0) return `╶${"─".repeat(Math.max(0, width - 1))}╴`;
	if (filled >= width) return `╶${"─".repeat(Math.max(0, width - 2))}╸╴`;
	const head = Math.max(0, filled - 1);
	const tail = Math.max(0, width - filled - 1);
	return `╶${"─".repeat(head)}╸${"─".repeat(tail)}╴`;
}

export function formatResetShort(resetsAt: string | undefined, now: Date): string | undefined {
	if (!resetsAt) return undefined;
	const date = new Date(resetsAt);
	if (Number.isNaN(date.getTime())) return undefined;
	const delta = date.getTime() - now.getTime();
	if (delta <= 0) return "now";
	const minutes = Math.floor(delta / 60_000);
	if (minutes < 60) return `${Math.max(minutes, 1)}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

export function formatResetLong(resetsAt: string | undefined, now: Date): string | undefined {
	if (!resetsAt) return undefined;
	const date = new Date(resetsAt);
	if (Number.isNaN(date.getTime())) return undefined;
	const delta = date.getTime() - now.getTime();
	if (delta <= 0) return "resets soon";
	const minutes = Math.max(Math.ceil(delta / 60_000), 0);
	if (minutes < 60) return `resets in ${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `resets in ${hours}h ${minutes % 60}m`;
	return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}
