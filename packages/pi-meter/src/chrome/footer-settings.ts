import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { LedgerWindowMode, MeterConfig } from "../config.ts";
import { FOOTER_LOCALS, renderLocalFooter, type FooterStats } from "../ledger/footer.ts";
import type { QuotaWindowView } from "../quota/policy.ts";
import { renderStatusText } from "./widget.ts";

export interface FooterSettingsTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

export interface FooterSettingsPreview {
	stats: FooterStats;
	quota?: QuotaWindowView;
	quotaHint?: { label: string; value: string };
}

export interface FooterEditorValue {
	footer: MeterConfig["footer"];
	windowMode: LedgerWindowMode;
}

const ROWS = ["local", "quota-visible", "quota-polarity", "window-mode"] as const;
type RowId = typeof ROWS[number];

export class FooterSettingsDashboard {
	private cursor = 0;
	private cachedWidth = -1;
	private cachedLines: string[] = [];
	private value: FooterEditorValue;

	constructor(
		current: FooterEditorValue,
		private preview: FooterSettingsPreview,
		private theme: FooterSettingsTheme,
	) {
		this.value = {
			footer: {
				local: current.footer.local,
				quota: { ...current.footer.quota },
			},
			windowMode: current.windowMode,
		};
	}

	public onDone?: (value: FooterEditorValue) => void;

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.onDone?.(this.settings());
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.cursor = (this.cursor + 1) % ROWS.length;
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.cursor = (this.cursor - 1 + ROWS.length) % ROWS.length;
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.right) || data === " ") {
			this.cycle(1);
			return;
		}
		if (matchesKey(data, Key.left)) this.cycle(-1);
	}

	settings(): FooterEditorValue {
		return {
			footer: {
				local: this.value.footer.local,
				quota: { ...this.value.footer.quota },
			},
			windowMode: this.value.windowMode,
		};
	}

	invalidate(): void {
		this.cachedWidth = -1;
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines.length > 0) return this.cachedLines;
		const t = this.theme;
		const safeWidth = Math.max(1, width);
		const preview = renderStatusText({
			local: renderLocalFooter(this.value.footer.local, this.preview.stats, this.value.windowMode),
			quota: this.value.footer.quota.visible ? this.preview.quota : undefined,
			quotaHint: this.value.footer.quota.visible ? this.preview.quotaHint : undefined,
			polarity: this.value.footer.quota.polarity,
		}, t as never) ?? "· footer hidden";
		const rows = ROWS.map((id, index) => this.renderRow(id, index === this.cursor, safeWidth));
		const selected = ROWS[this.cursor];
		const lines = [
			t.fg("accent", t.bold("pi-meter — footer settings")),
			"",
			t.fg("dim", "Preview"),
			preview,
			"",
			...rows,
			"",
			t.fg("muted", this.description(selected)),
			"",
			t.fg("dim", "[↑↓] move  [enter/space] change  [q/esc] save & close"),
		];
		this.cachedWidth = width;
		this.cachedLines = lines.map((line) => truncateToWidth(line, safeWidth, ""));
		return this.cachedLines;
	}

	private cycle(delta: number): void {
		switch (ROWS[this.cursor]) {
			case "local": {
				const index = FOOTER_LOCALS.findIndex((item) => item.key === this.value.footer.local);
				const next = (index + delta + FOOTER_LOCALS.length) % FOOTER_LOCALS.length;
				this.value.footer.local = FOOTER_LOCALS[next]!.key;
				break;
			}
			case "quota-visible":
				this.value.footer.quota.visible = !this.value.footer.quota.visible;
				break;
			case "quota-polarity":
				this.value.footer.quota.polarity = this.value.footer.quota.polarity === "remaining" ? "used" : "remaining";
				break;
			case "window-mode":
				this.value.windowMode = this.value.windowMode === "rolling" ? "calendar" : "rolling";
				break;
		}
		this.invalidate();
	}

	private renderRow(id: RowId, selected: boolean, width: number): string {
		const t = this.theme;
		const marker = selected ? "▶ " : "  ";
		const label = id === "local"
			? "Local summary"
			: id === "quota-visible"
				? "Quota window"
				: id === "quota-polarity"
					? "Quota display"
					: "Local window";
		const value = id === "local"
			? FOOTER_LOCALS.find((item) => item.key === this.value.footer.local)?.label ?? this.value.footer.local
			: id === "quota-visible"
				? this.value.footer.quota.visible ? "On" : "Off"
				: id === "quota-polarity"
					? this.value.footer.quota.polarity === "remaining" ? "Remaining" : "Used"
					: this.value.windowMode === "rolling" ? "Rolling" : "Calendar";
		const labelText = `${label}${" ".repeat(Math.max(1, 18 - label.length))}`;
		return truncateToWidth(
			marker + (selected ? t.fg("accent", t.bold(labelText)) : labelText) + t.fg(selected ? "accent" : "text", value),
			width,
			"",
		);
	}

	private description(id: RowId): string {
		if (id === "local") return FOOTER_LOCALS.find((item) => item.key === this.value.footer.local)?.description ?? "local usage summary";
		if (id === "quota-visible") return "show or hide the current model's subscription window";
		if (id === "quota-polarity") return "show subscription quota as remaining or used";
		return "count local spend from now backwards, or from calendar midnights. Budgets stay on the calendar.";
	}
}
