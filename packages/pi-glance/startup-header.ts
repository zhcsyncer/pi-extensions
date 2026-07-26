import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ResolvedGlanceStyles } from "./theme-adapter.js";

export const STARTUP_TIPS = [
	"Type / to browse commands.",
	"Prefix ! to run Bash; !! keeps output out of context.",
	"Use /glance to tune the input surface.",
	"Drop files into the terminal to add context.",
	"Ask Pi to explain its own features or look up its docs.",
] as const;

export const STARTUP_COMMANDS = ["/glance", "/model", "/settings", "/hotkeys"] as const;

export interface StartupHeaderInfo {
	version: string;
	model?: string;
	thinking?: string;
	cwd?: string;
}

export interface GlanceStartupHeaderOptions {
	tip: string;
	getStyles: () => ResolvedGlanceStyles;
	getInfo: () => StartupHeaderInfo;
}

type LogoRole = "title" | "error" | "success" | "warn";

const LOGO_CELL = "██";
const LOGO_GRID: ReadonlyArray<ReadonlyArray<LogoRole | undefined>> = [
	[undefined, "title", "title", "title", undefined],
	[undefined, "error", undefined, "title", undefined],
	[undefined, "error", "error", undefined, "success"],
	[undefined, "error", undefined, undefined, "success"],
	["warn", "warn", "warn", "warn", "warn"],
];

const MIN_LEFT_WIDTH = 28;
const MIN_RIGHT_WIDTH = 16;
const MAX_RIGHT_WIDTH = 28;
const COLUMN_GAP = 3;
const MIN_BOX_WIDTH = 24;

function finiteRandom(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(0.999999999999, value));
}

export function selectStartupTip(random: () => number = Math.random): string {
	const index = Math.floor(finiteRandom(random()) * STARTUP_TIPS.length);
	return STARTUP_TIPS[index] ?? STARTUP_TIPS[0];
}

function fitLine(text: string, width: number, ellipsis = ""): string {
	return truncateToWidth(text, Math.max(0, width), ellipsis);
}

function padRight(text: string, width: number, ellipsis = ""): string {
	const clipped = fitLine(text, width, ellipsis);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function center(text: string, width: number): string {
	const clipped = fitLine(text, width, width > 1 ? "…" : "");
	const remaining = Math.max(0, width - visibleWidth(clipped));
	const left = Math.floor(remaining / 2);
	return `${" ".repeat(left)}${clipped}${" ".repeat(remaining - left)}`;
}

function formatCwd(cwd: string | undefined, home = process.env.HOME): string {
	if (!cwd) return "";
	if (home && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`;
	return cwd;
}

function formatModelLine(info: StartupHeaderInfo): string {
	const model = info.model?.trim() || "Default model";
	const thinking = info.thinking?.trim() || "off";
	return `${model} · ${thinking} effort`;
}

function renderLogo(styles: ResolvedGlanceStyles): string[] {
	return LOGO_GRID.map((row) =>
		row
			.map((role) => (role ? styles[role](LOGO_CELL) : " ".repeat(LOGO_CELL.length)))
			.join(""),
	);
}

function columnWidths(innerWidth: number): { leftWidth: number; rightWidth: number; dual: boolean } {
	if (innerWidth < MIN_LEFT_WIDTH + COLUMN_GAP + MIN_RIGHT_WIDTH) {
		return { leftWidth: Math.max(0, innerWidth), rightWidth: 0, dual: false };
	}
	let rightWidth = Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, Math.round(innerWidth * 0.28)));
	let leftWidth = innerWidth - COLUMN_GAP - rightWidth;
	if (leftWidth < MIN_LEFT_WIDTH) {
		leftWidth = MIN_LEFT_WIDTH;
		rightWidth = innerWidth - COLUMN_GAP - leftWidth;
	}
	return { leftWidth, rightWidth, dual: rightWidth >= MIN_RIGHT_WIDTH };
}

function topBorder(width: number, label: string, styles: ResolvedGlanceStyles): string {
	if (width <= 1) return fitLine(styles.border("─"), width);
	if (width < 8) return fitLine(styles.border(`╭${"─".repeat(Math.max(0, width - 2))}╮`), width);
	const before = "─── ";
	const after = " ─────";
	const innerWidth = width - 2;
	const labelWidth = Math.max(1, innerWidth - visibleWidth(before) - visibleWidth(after));
	const fittedLabel = fitLine(label, labelWidth, labelWidth > 1 ? "…" : "");
	const fill = Math.max(0, innerWidth - visibleWidth(before) - visibleWidth(fittedLabel) - visibleWidth(after));
	return fitLine(
		`${styles.border(`╭${before}`)}${fittedLabel}${styles.border(`${after}${"─".repeat(fill)}╮`)}`,
		width,
	);
}

function bottomBorder(width: number, styles: ResolvedGlanceStyles): string {
	if (width <= 1) return fitLine(styles.border("─"), width);
	return styles.border(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

function boxedLine(content: string, width: number, styles: ResolvedGlanceStyles): string {
	if (width <= 2) return fitLine(content, width);
	return `${styles.border("│")}${padRight(content, width - 2)}${styles.border("│")}`;
}

function twoColumn(left: string, right: string, leftWidth: number, rightWidth: number, styles: ResolvedGlanceStyles): string {
	return `${padRight(left, leftWidth)} ${styles.border("│")} ${padRight(right, rightWidth, "…")}`;
}

export class GlanceStartupHeader implements Component {
	constructor(
		private readonly theme: Pick<Theme, "bold">,
		private readonly options: GlanceStartupHeaderOptions,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
		const styles = this.options.getStyles();
		const info = this.options.getInfo();
		const brand = this.theme.bold(styles.title("Pi · Glance"));
		const tipTitle = this.theme.bold(styles.title("Getting started"));
		const commandsTitle = this.theme.bold(styles.title("Commands"));
		const model = styles.dim(formatModelLine(info));
		const cwd = styles.dim(formatCwd(info.cwd));
		const tip = styles.dim(this.options.tip);
		const versionLabel = `${styles.title("Pi")} ${styles.text(`v${info.version}`)}`;

		if (safeWidth < MIN_BOX_WIDTH) {
			const compactBrand = this.theme.bold(styles.title("◌ Pi · Glance"));
			const lines = [fitLine(compactBrand, safeWidth, safeWidth > 1 ? "…" : "")];
			if (safeWidth >= 12) lines.push(fitLine(`${styles.title("Tip")}  ${tip}`, safeWidth, "…"));
			return lines;
		}

		const innerWidth = safeWidth - 2;
		const widths = columnWidths(innerWidth);
		const logo = renderLogo(styles);
		const lines = [topBorder(safeWidth, versionLabel, styles)];

		if (widths.dual) {
			const leftLines = [
				...logo.map((line) => center(line, widths.leftWidth)),
				center(brand, widths.leftWidth),
				center(model, widths.leftWidth),
				center(cwd, widths.leftWidth),
				"",
			];
			const divider = styles.border("─".repeat(Math.max(8, Math.min(widths.rightWidth, 22))));
			const rightLines = [
				"",
				tipTitle,
				tip,
				divider,
				commandsTitle,
				...STARTUP_COMMANDS.map((command) => styles.dim(command)),
			];
			for (let index = 0; index < Math.max(leftLines.length, rightLines.length); index++) {
				lines.push(
					boxedLine(
						twoColumn(leftLines[index] ?? "", rightLines[index] ?? "", widths.leftWidth, widths.rightWidth, styles),
						safeWidth,
						styles,
					),
				);
			}
		} else {
			const commandLine = `${commandsTitle}  ${styles.dim(STARTUP_COMMANDS.join(" · "))}`;
			const body = [
				...logo.map((line) => center(line, innerWidth)),
				center(brand, innerWidth),
				center(model, innerWidth),
				center(cwd, innerWidth),
				fitLine(`${tipTitle}  ${tip}`, innerWidth, "…"),
				fitLine(commandLine, innerWidth, "…"),
			];
			for (const line of body) lines.push(boxedLine(line, safeWidth, styles));
		}

		lines.push(bottomBorder(safeWidth, styles));
		return lines.map((line) => fitLine(line, safeWidth));
	}
}
