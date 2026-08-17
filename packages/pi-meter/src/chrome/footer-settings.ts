import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { MeterConfig } from "../config.ts";
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

type FooterSettings = MeterConfig["footer"];

const ROWS = ["local", "quota-visible", "quota-polarity"] as const;
type RowId = typeof ROWS[number];

export class FooterSettingsDashboard {
	private cursor = 0;
	private cachedWidth = -1;
	private cachedLines: string[] = [];
	private value: FooterSettings;

	constructor(
		current: FooterSettings,
		private preview: FooterSettingsPreview,
		private theme: FooterSettingsTheme,
	) {
		this.value = {
			local: current.local,
			quota: { ...current.quota },
		};
	}

	public onDone?: (value: FooterSettings) => void;

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

	settings(): FooterSettings {
		return {
			local: this.value.local,
			quota: { ...this.value.quota },
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
			local: renderLocalFooter(this.value.local, this.preview.stats),
			quota: this.value.quota.visible ? this.preview.quota : undefined,
			quotaHint: this.value.quota.visible ? this.preview.quotaHint : undefined,
			polarity: this.value.quota.polarity,
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
				const index = FOOTER_LOCALS.findIndex((item) => item.key === this.value.local);
				const next = (index + delta + FOOTER_LOCALS.length) % FOOTER_LOCALS.length;
				this.value.local = FOOTER_LOCALS[next]!.key;
				break;
			}
			case "quota-visible":
				this.value.quota.visible = !this.value.quota.visible;
				break;
			case "quota-polarity":
				this.value.quota.polarity = this.value.quota.polarity === "remaining" ? "used" : "remaining";
				break;
		}
		this.invalidate();
	}

	private renderRow(id: RowId, selected: boolean, width: number): string {
		const t = this.theme;
		const marker = selected ? "▶ " : "  ";
		const label = id === "local" ? "Local summary" : id === "quota-visible" ? "Quota window" : "Quota display";
		const value = id === "local"
			? FOOTER_LOCALS.find((item) => item.key === this.value.local)?.label ?? this.value.local
			: id === "quota-visible"
				? this.value.quota.visible ? "On" : "Off"
				: this.value.quota.polarity === "remaining" ? "Remaining" : "Used";
		const labelText = `${label}${" ".repeat(Math.max(1, 18 - label.length))}`;
		return truncateToWidth(
			marker + (selected ? t.fg("accent", t.bold(labelText)) : labelText) + t.fg(selected ? "accent" : "text", value),
			width,
			"",
		);
	}

	private description(id: RowId): string {
		if (id === "local") return FOOTER_LOCALS.find((item) => item.key === this.value.local)?.description ?? "local usage summary";
		if (id === "quota-visible") return "show or hide the current model's subscription window";
		return "show subscription quota as remaining or used";
	}
}
