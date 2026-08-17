import type { Theme } from "@earendil-works/pi-coding-agent";
import type { QuotaPolarity } from "../config.ts";
import type { QuotaWindowView } from "../quota/policy.ts";
import { displayedPercent, formatResetShort, quotaTone, renderQuotaBar } from "./format.ts";

export const STATUS_KEY = "pi-meter";

export interface ChromeInput {
	local?: string;
	quota?: QuotaWindowView;
	quotaHint?: { label: string; value: string };
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

export function renderStatusText(input: ChromeInput, theme: Theme): string | undefined {
	const now = input.now ?? new Date();
	const parts: string[] = [];
	if (input.local) parts.push(theme.fg("muted", input.local));
	if (input.quota) {
		const quota = quotaCaption(input.quota, input.polarity, now);
		parts.push(`${theme.fg("muted", quota.label)} ${theme.fg(quota.tone, quota.value)}`);
	} else if (input.quotaHint) {
		parts.push(theme.fg("muted", input.quotaHint.label), theme.fg("muted", input.quotaHint.value));
	}
	if (parts.length === 0) return undefined;
	// Pi/Glance join foreign statuses with a space. A leading mid-dot keeps
	// "granted today" from reading as one phrase.
	return `${theme.fg("dim", "·")} ${parts.join(theme.fg("dim", " · "))}`;
}

export function renderChromeLine(input: ChromeInput, _width: number, theme: Theme): string[] {
	const text = renderStatusText(input, theme);
	return text ? [text] : [];
}
