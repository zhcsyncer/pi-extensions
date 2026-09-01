import { displayedPercent, formatExpiryClock, formatResetDuration, formatResetLong, formatSnapshotAge, nearestExpiry, quotaTone } from "./format.ts";
import type { QuotaPolarity } from "../config.ts";
import { isUnsignedQuotaSnapshot } from "../quota/auth.ts";
import type { QuotaResets, QuotaSnapshot, QuotaWindow } from "../quota/types.ts";

function bar(usedPercent: number, polarity: QuotaPolarity, width = 10): string {
	const ratio = displayedPercent(usedPercent, polarity) / 100;
	const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width);
	return `[${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}]`;
}

function isUnsignedIn(snapshot: QuotaSnapshot): boolean {
	return isUnsignedQuotaSnapshot(snapshot);
}

function unsignedInHint(snapshots: readonly QuotaSnapshot[]): string | undefined {
	if (snapshots.length === 0) return undefined;
	return `Not signed in: ${snapshots.map((snapshot) => snapshot.title).join(", ")} — run /login`;
}

function snapshotHeading(snapshot: QuotaSnapshot, now: Date): string {
	const age = formatSnapshotAge(snapshot.fetchedAt, now);
	return age ? `${snapshot.title} · ${age}` : snapshot.title;
}

function formatWindow(window: QuotaWindow, polarity: QuotaPolarity, now: Date): string {
	const percent = Math.round(displayedPercent(window.usedPercent, polarity));
	const reset = formatResetLong(window.resetsAt, now);
	const parts = [`  ${window.label.padEnd(22)}`, bar(window.usedPercent, polarity), `${String(percent).padStart(3)}%`];
	if (reset) parts.push(`· ${reset}`);
	if (window.note) parts.push(`· ${window.note}`);
	return parts.join(" ");
}

function visibleResetItems(resets: QuotaResets, now: Date): NonNullable<QuotaResets["items"]> {
	return (resets.items ?? []).filter((item) => {
		const time = new Date(item.expiresAt).getTime();
		return !Number.isNaN(time) && time > now.getTime();
	});
}

function formatResetItem(item: { expiresAt: string; title?: string }, index: number, now: Date): string {
	const title = item.title?.trim();
	const clock = formatExpiryClock(item.expiresAt);
	const duration = formatResetDuration(item.expiresAt, now);
	const bits = [`    #${index + 1}`];
	if (title) bits.push(title);
	if (clock) bits.push(`· ${clock}`);
	if (duration) bits.push(`(${duration})`);
	return bits.join(" ");
}

function formatResets(resets: QuotaResets | undefined, now: Date): string[] | undefined {
	if (!resets || resets.availableCount <= 0) return undefined;
	const items = visibleResetItems(resets, now);
	const next = formatResetDuration(nearestExpiry(items, now), now);
	const header = `  ${"Resets".padEnd(22)} ${resets.availableCount} available${next ? ` · next ${next}` : ""}`;
	return [header, ...items.map((item, index) => formatResetItem(item, index, now))];
}

export function renderUsagePanel(
	snapshots: readonly QuotaSnapshot[],
	polarity: QuotaPolarity,
	now: Date = new Date(),
): string {
	const blocks: string[] = [];
	const unsignedIn: QuotaSnapshot[] = [];
	for (const snapshot of snapshots) {
		if (isUnsignedIn(snapshot)) {
			unsignedIn.push(snapshot);
			continue;
		}
		const heading = snapshotHeading(snapshot, now);
		if (!snapshot.ok) {
			blocks.push(`${heading}\n  ${snapshot.error ?? "unavailable"}`);
			continue;
		}
		const rows = snapshot.windows.map((window) => formatWindow(window, polarity, now));
		const resetRows = formatResets(snapshot.resets, now);
		if (rows.length === 0 && !resetRows) {
			blocks.push(`${heading}\n  (no usage data reported)`);
			continue;
		}
		blocks.push([heading, ...rows, ...(resetRows ?? [])].join("\n"));
	}
	const hint = unsignedInHint(unsignedIn);
	if (blocks.length === 0) return hint ?? "No subscription snapshots yet.";
	return hint ? `${blocks.join("\n\n")}\n\n${hint}` : blocks.join("\n\n");
}

export function usageSeverity(snapshots: readonly QuotaSnapshot[], polarity: QuotaPolarity): "info" | "warning" {
	for (const snapshot of snapshots) {
		if (isUnsignedIn(snapshot)) continue;
		if (!snapshot.ok) return "warning";
		for (const window of snapshot.windows) {
			const tone = quotaTone(window.usedPercent);
			if (tone !== "muted") return "warning";
		}
	}
	void polarity;
	return "info";
}
