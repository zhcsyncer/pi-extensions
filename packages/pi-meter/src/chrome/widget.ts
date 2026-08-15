import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { QuotaPolarity } from "../config.ts";
import { fmtCompactCost, fmtCompactTokens } from "../ledger/format.ts";
import type { AggRow } from "../ledger/types.ts";
import type { QuotaWindowView } from "../quota/policy.ts";
import { displayedPercent, formatResetShort, quotaTone, renderQuotaBar } from "./format.ts";

export interface ChromeInput {
	today: AggRow;
	tokenDetails: boolean;
	quota?: QuotaWindowView;
	polarity: QuotaPolarity;
	now?: Date;
}

function tokenCaption(today: AggRow, details: boolean): string {
	if (details) {
		const parts = [
			`↑${fmtCompactTokens(today.input)}`,
			`↓${fmtCompactTokens(today.output)}`,
			`hit ${fmtCompactTokens(today.cacheRead)}`,
		];
		return parts.join(" ");
	}
	const tokens = fmtCompactTokens(today.tokens);
	const cost = today.costKnown ? fmtCompactCost(today.cost) : undefined;
	return cost ? `${tokens}  ${cost}` : tokens;
}

function quotaCaption(quota: QuotaWindowView | undefined, polarity: QuotaPolarity, now: Date): string | undefined {
	if (!quota) return "—";
	const percent = Math.round(displayedPercent(quota.window.usedPercent, polarity));
	const reset = formatResetShort(quota.window.resetsAt, now);
	const stale = quota.stale ? " stale" : "";
	return `${renderQuotaBar(quota.window.usedPercent, polarity)} ${percent}%${reset ? ` · ${reset}` : ""}${stale}`;
}

export function renderChromeLine(input: ChromeInput, width: number, theme: Theme): string[] {
	if (width <= 0) return [];
	const now = input.now ?? new Date();
	const quotaText = quotaCaption(input.quota, input.polarity, now) ?? "—";
	const tone = input.quota ? quotaTone(input.quota.window.usedPercent) : "muted";
	const right = theme.fg(tone, quotaText);
	const detailedLeft = theme.fg("muted", tokenCaption(input.today, true));
	const compactLeft = theme.fg("muted", tokenCaption(input.today, false));
	const emptyLeft = "";

	const candidates = input.tokenDetails
		? [detailedLeft, compactLeft, emptyLeft]
		: [compactLeft, emptyLeft];

	for (const left of candidates) {
		const line = composeRightAligned(left, right, width);
		if (line !== undefined) return [truncateToWidth(line, width)];
	}
	return [truncateToWidth(right, width)];
}

function composeRightAligned(left: string, right: string, width: number): string | undefined {
	const rightWidth = visibleWidth(right);
	if (rightWidth > width) return undefined;
	if (!left) return `${" ".repeat(Math.max(0, width - rightWidth))}${right}`;
	const leftWidth = visibleWidth(left);
	if (leftWidth + 2 + rightWidth > width) return undefined;
	return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
}
