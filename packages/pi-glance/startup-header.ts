import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

export const STARTUP_TIPS = [
	"Type / to browse commands.",
	"Prefix ! to run Bash; !! keeps output out of context.",
	"Use /glance to tune the input surface.",
	"Drop files into the terminal to add context.",
	"Ask Pi to explain its own features or look up its docs.",
] as const;

type LogoToken = "accent" | "error" | "success" | "warning";

const LOGO_CELL = "██";
const LOGO_GRID: ReadonlyArray<ReadonlyArray<LogoToken | undefined>> = [
	[undefined, "accent", "accent", "accent", undefined],
	[undefined, "error", undefined, "accent", undefined],
	[undefined, "error", "error", undefined, "success"],
	[undefined, "error", undefined, undefined, "success"],
	["warning", "warning", "warning", "warning", "warning"],
];

function finiteRandom(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(0.999999999999, value));
}

export function selectStartupTip(random: () => number = Math.random): string {
	const index = Math.floor(finiteRandom(random()) * STARTUP_TIPS.length);
	return STARTUP_TIPS[index] ?? STARTUP_TIPS[0];
}

function padRight(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width), "");
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function center(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width), "");
	const remaining = Math.max(0, width - visibleWidth(clipped));
	const left = Math.floor(remaining / 2);
	return `${" ".repeat(left)}${clipped}${" ".repeat(remaining - left)}`;
}

function renderLogo(theme: Theme): string[] {
	return LOGO_GRID.map((row) =>
		row
			.map((token) => (token ? theme.fg(token, LOGO_CELL) : " ".repeat(LOGO_CELL.length)))
			.join(""),
	);
}

function fitLine(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width), width > 1 ? "…" : "");
}

export class GlanceStartupHeader implements Component {
	constructor(
		private readonly theme: Theme,
		private readonly tip: string,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
		const logo = renderLogo(this.theme);
		const brand = this.theme.bold(this.theme.fg("accent", "Pi · Glance"));
		const tipLabel = this.theme.fg("accent", "Tip");
		const tipText = this.theme.fg("muted", this.tip);

		if (safeWidth < 36) {
			const compactBrand = this.theme.bold(this.theme.fg("accent", "◌ Pi · Glance"));
			const lines = [fitLine(compactBrand, safeWidth)];
			if (safeWidth >= 12) lines.push(fitLine(`${tipLabel}  ${tipText}`, safeWidth));
			return lines;
		}

		if (safeWidth < 72) {
			return [
				...logo.map((line) => center(line, safeWidth)),
				center(brand, safeWidth),
				center(fitLine(`${tipLabel}  ${tipText}`, safeWidth), safeWidth),
			];
		}

		const logoWidth = Math.max(...logo.map(visibleWidth));
		const gap = 4;
		const copyWidth = Math.max(1, safeWidth - logoWidth - gap);
		const copy = ["", brand, `${tipLabel}  ${tipText}`, "", ""];
		return logo.map((line, index) =>
			fitLine(`${padRight(line, logoWidth)}${" ".repeat(gap)}${fitLine(copy[index] ?? "", copyWidth)}`, safeWidth),
		);
	}
}
