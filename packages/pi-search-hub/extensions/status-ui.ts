/**
 * /search-hub status — local quota ledger. Does not fetch usage on open.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { BACKEND_DEFS } from "./backends/registry.js";
import { getConfig, refreshConfig } from "./config.js";
import { resolveBackendKeys } from "./credentials.js";
import {
	fingerprintKey,
	formatLocalDateTime,
	keySkipUntil,
	maybeRefreshKeyUsage,
	quotaSkipUntil,
	readQuotaState,
	USAGE_BACKENDS,
	type BackendQuotaEntry,
	type KeyQuotaEntry,
} from "./quota-skips.js";
import { SEARCH_BACKEND_NAMES } from "./types.js";

type StatusLine =
	| { kind: "vendor"; name: string; detail: string; disabled?: boolean }
	| { kind: "key"; text: string; disabled?: boolean }
	| { kind: "blank" };

function ageLabel(fetchedAt: number | undefined, now: number): string {
	if (fetchedAt === undefined) return "no snapshot";
	const delta = Math.max(0, now - fetchedAt);
	if (delta < 60_000) return "just now";
	if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
	if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
	return `${Math.round(delta / 86_400_000)}d ago`;
}

function disabledLabel(until: number | undefined, now: number): string | undefined {
	if (until === undefined || until <= now) return undefined;
	return `DISABLED until ${formatLocalDateTime(until)}`;
}

function keyLine(index: number, entry: KeyQuotaEntry | undefined, skipUntil: number | undefined, now: number): Extract<StatusLine, { kind: "key" }> {
	const disabled = disabledLabel(skipUntil, now);
	const usage = entry?.usage;
	const limit = entry?.limit;
	const remaining = entry?.remaining;
	const parts = [`Key ${index + 1}`];
	if (limit !== undefined && usage !== undefined) parts.push(`${usage}/${limit}`);
	else if (remaining !== undefined) parts.push(`${remaining} remaining`);
	if (remaining !== undefined && limit !== undefined) parts.push(`remaining ${remaining}`);
	parts.push(disabled ?? "ok");
	return {
		kind: "key",
		text: `  ${parts.join("  ")}`,
		disabled: Boolean(disabled),
	};
}

function plainStatusText(lines: StatusLine[]): string {
	return lines.map((line) => {
		if (line.kind === "blank") return "";
		if (line.kind === "vendor") return `${line.name}  ${line.detail}`.trim();
		return line.text;
	}).join("\n");
}

export function formatQuotaStatusLines(now = Date.now()): StatusLine[] {
	const config = getConfig();
	const state = readQuotaState();
	const lines: StatusLine[] = [];
	for (const name of SEARCH_BACKEND_NAMES) {
		const def = BACKEND_DEFS[name];
		if (!def) continue;
		if (lines.length > 0) lines.push({ kind: "blank" });
		const entry: BackendQuotaEntry = state[name] ?? {};
		const backendUntil = quotaSkipUntil(name, now);
		const keys = def.providerAuth ? [] : resolveBackendKeys(name, config);
		const keyEntries = keys.map((key) => {
			const id = fingerprintKey(key);
			return {
				entry: entry.keys?.[id],
				skipUntil: keySkipUntil(name, key, now),
			};
		});
		const usageSum = keyEntries.reduce((sum, item) => sum + (item.entry?.usage ?? 0), 0);
		const limitSum = keyEntries.reduce((sum, item) => sum + (item.entry?.limit ?? 0), 0);
		const remainingSum = keyEntries.reduce((sum, item) => {
			if (item.entry?.remaining !== undefined) return sum + item.entry.remaining;
			if (item.entry?.limit !== undefined && item.entry.usage !== undefined) {
				return sum + Math.max(0, item.entry.limit - item.entry.usage);
			}
			return sum;
		}, 0);
		const hasUsage = USAGE_BACKENDS.has(name);
		const details: string[] = [];
		if (hasUsage && keys.length > 0 && limitSum > 0) {
			details.push(`${usageSum}/${limitSum}  remaining ${remainingSum}`);
		} else if (hasUsage) {
			details.push(ageLabel(entry.fetchedAt, now));
		} else if (def.providerAuth) {
			details.push("pi auth");
		} else {
			details.push("no remaining API");
		}
		const backendDisabled = disabledLabel(backendUntil, now);
		if (backendDisabled) details.push(backendDisabled);
		else if (keys.length > 0 && keyEntries.every((item) => item.skipUntil !== undefined)) {
			const latest = keyEntries.reduce((max, item) => Math.max(max, item.skipUntil ?? 0), 0);
			details.push(disabledLabel(latest, now) ?? "all keys skipped");
		}
		if (hasUsage && entry.fetchedAt) details.push(`(${ageLabel(entry.fetchedAt, now)})`);
		lines.push({
			kind: "vendor",
			name: def.label,
			detail: details.join("  "),
			disabled: Boolean(backendDisabled),
		});
		keyEntries.forEach((item, index) => {
			lines.push(keyLine(index, item.entry, item.skipUntil, now));
		});
	}
	return lines;
}

function renderStatus(theme: { fg: (color: any, text: string) => string; bold: (text: string) => string }, now = Date.now()): string[] {
	const lines = [
		`${theme.bold("Search Hub status")}  ${theme.fg("dim", "local ledger")}`,
		"",
	];
	for (const line of formatQuotaStatusLines(now)) {
		if (line.kind === "blank") {
			lines.push("");
			continue;
		}
		if (line.kind === "vendor") {
			const name = theme.fg("accent", theme.bold(line.name));
			const detail = line.disabled ? theme.fg("warning", line.detail) : theme.fg("dim", line.detail);
			lines.push(`${name}  ${detail}`.trim());
			continue;
		}
		lines.push(line.disabled ? theme.fg("warning", line.text) : theme.fg("dim", line.text));
	}
	lines.push("");
	lines.push(theme.fg("dim", "r refresh · Esc close"));
	return lines;
}

async function refreshUsageSnapshots(): Promise<"refreshed" | "min-interval" | "skipped"> {
	const config = getConfig();
	let refreshed = false;
	let blocked = false;
	for (const backend of USAGE_BACKENDS) {
		const keys = resolveBackendKeys(backend, config);
		const result = await maybeRefreshKeyUsage(backend, keys, Date.now(), undefined, true);
		if (result === "refreshed") refreshed = true;
		if (result === "min-interval") blocked = true;
	}
	if (refreshed) return "refreshed";
	if (blocked) return "min-interval";
	return "skipped";
}

export async function openSearchStatus(ctx: ExtensionCommandContext, refresh = false): Promise<void> {
	refreshConfig(ctx.cwd, ctx.isProjectTrusted(), false, (message) => ctx.ui.notify(message, "warning"));
	if (refresh) {
		const result = await refreshUsageSnapshots();
		if (result === "min-interval") ctx.ui.notify("Search Hub usage was refreshed too recently. Try again in a minute.", "warning");
	}
	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui.notify(plainStatusText(formatQuotaStatusLines()), "info");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const body = new Text(renderStatus(theme).join("\n"), 0, 0);
		let busy = false;
		const container = new Container();
		container.addChild(body);
		container.addChild(new Spacer(1));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				const kb = getKeybindings();
				if (kb.matches(data, "tui.select.cancel") || data === "q" || data === "Q") {
					done();
					return;
				}
				if ((data === "r" || data === "R") && !busy) {
					busy = true;
					body.setText(theme.fg("dim", "Refreshing usage…"));
					tui.requestRender();
					void refreshUsageSnapshots().then((result) => {
						if (result === "min-interval") {
							ctx.ui.notify("Search Hub usage was refreshed too recently. Try again in a minute.", "warning");
						}
						body.setText(renderStatus(theme).join("\n"));
						busy = false;
						tui.requestRender();
					});
				}
			},
		} satisfies Component;
	});
}
