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

export function renderQuotaBar(usedPercent: number, polarity: QuotaPolarity, width = 5): string {
	const filled = Math.round((displayedPercent(usedPercent, polarity) / 100) * width);
	const clamped = Math.min(width, Math.max(0, filled));
	return `${"█".repeat(clamped)}${"░".repeat(Math.max(0, width - clamped))}`;
}

export function formatResetDuration(resetsAt: string | undefined, now: Date): string | undefined {
	if (!resetsAt) return undefined;
	const date = new Date(resetsAt);
	if (Number.isNaN(date.getTime())) return undefined;
	const delta = date.getTime() - now.getTime();
	if (delta <= 0) return undefined;
	const minutes = Math.max(Math.ceil(delta / 60_000), 1);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	if (hours < 24) return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
	const days = Math.floor(hours / 24);
	const remHours = hours % 24;
	return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`;
}

export function formatResetShort(resetsAt: string | undefined, now: Date): string | undefined {
	return formatResetDuration(resetsAt, now) ?? (resetsAt ? "now" : undefined);
}

export function formatResetLong(resetsAt: string | undefined, now: Date): string | undefined {
	const duration = formatResetDuration(resetsAt, now);
	if (duration) return `resets in ${duration}`;
	return resetsAt ? "resets soon" : undefined;
}
