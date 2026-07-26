import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ResolvedGlanceStyles } from "./theme-adapter.js";

export const STARTUP_TAGLINE = "Let's build something great";
export const STARTUP_PROMPT = "Ask Pi to build it";
export const PINNED_STARTUP_COMMAND = "/glance";

export interface StartupHeaderCommand {
	name: string;
	source: "extension" | "prompt" | "skill";
	sourceInfo: {
		path: string;
	};
}

export interface StartupHeaderResourceSummary {
	context: number;
	skills: number;
	prompts: number;
	extensions: number;
	extensionsAreLowerBound?: boolean;
}

export interface StartupHeaderInfo {
	version: string;
	resources: StartupHeaderResourceSummary;
}

export interface GlanceStartupHeaderOptions {
	commandTips: readonly string[];
	getStyles: () => ResolvedGlanceStyles;
	getInfo: () => StartupHeaderInfo;
}

type LogoRole = "title" | "error" | "success" | "warn";
type ResourceKey = keyof Pick<StartupHeaderResourceSummary, "context" | "skills" | "prompts" | "extensions">;

const LOGO_CELL = "██";
const LOGO_GRID: ReadonlyArray<ReadonlyArray<LogoRole | undefined>> = [
	[undefined, "title", "title", "title", undefined],
	[undefined, "error", undefined, "title", undefined],
	[undefined, "error", "error", undefined, "success"],
	[undefined, "error", undefined, undefined, "success"],
	["warn", "warn", "warn", "warn", "warn"],
];

const RESOURCE_LABELS: ReadonlyArray<readonly [ResourceKey, string, string]> = [
	["context", "Context", "C"],
	["skills", "Skills", "S"],
	["prompts", "Prompts", "P"],
	["extensions", "Extensions", "E"],
];

const MIN_LEFT_WIDTH = 28;
const MIN_RIGHT_WIDTH = 16;
const MAX_RIGHT_WIDTH = 28;
const COLUMN_GAP = 3;
const MIN_BOX_WIDTH = 24;
const STARTUP_COMMAND_COUNT = 4;

function finiteRandom(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(0.999999999999, value));
}

function normalizeCommandName(name: string): string | undefined {
	const trimmed = name.trim().replace(/^\/+/, "");
	return trimmed ? `/${trimmed}` : undefined;
}

export function selectStartupCommandTips(
	commandNames: readonly string[],
	random: () => number = Math.random,
	count = STARTUP_COMMAND_COUNT,
): string[] {
	const targetCount = Math.max(1, Math.floor(Number.isFinite(count) ? count : STARTUP_COMMAND_COUNT));
	const unique = new Set<string>();
	for (const name of commandNames) {
		const normalized = normalizeCommandName(name);
		if (normalized && normalized !== PINNED_STARTUP_COMMAND) unique.add(normalized);
	}
	const pool = [...unique];
	const selected = [PINNED_STARTUP_COMMAND];
	while (selected.length < targetCount && pool.length > 0) {
		const index = Math.floor(finiteRandom(random()) * pool.length);
		selected.push(pool.splice(index, 1)[0]!);
	}
	return selected;
}

function distinctSourcePathCount(commands: readonly StartupHeaderCommand[], source: StartupHeaderCommand["source"]): number {
	return new Set(
		commands
			.filter((command) => command.source === source)
			.map((command) => command.sourceInfo.path.trim())
			.filter(Boolean),
	).size;
}

export function summarizeStartupResources(contextFileCount: number, commands: readonly StartupHeaderCommand[]): StartupHeaderResourceSummary {
	return {
		context: Math.max(0, Math.floor(Number.isFinite(contextFileCount) ? contextFileCount : 0)),
		skills: distinctSourcePathCount(commands, "skill"),
		prompts: distinctSourcePathCount(commands, "prompt"),
		extensions: distinctSourcePathCount(commands, "extension"),
		extensionsAreLowerBound: true,
	};
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

function sectionBorder(width: number, label: string, styles: ResolvedGlanceStyles): string {
	if (width <= 2) return fitLine(styles.border("─".repeat(width)), width);
	const plainLabel = ` ${label} `;
	if (width < visibleWidth(plainLabel) + 4) return styles.border(`├${"─".repeat(width - 2)}┤`);
	const fill = Math.max(0, width - visibleWidth(label) - 5);
	return `${styles.border("├─ ")}${styles.title(label)}${styles.border(` ${"─".repeat(fill)}┤`)}`;
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

function resourceCount(resources: StartupHeaderResourceSummary, key: ResourceKey): string {
	const count = String(resources[key]);
	return key === "extensions" && resources.extensionsAreLowerBound ? `${count}+` : count;
}

function renderResourceSummary(resources: StartupHeaderResourceSummary, width: number, styles: ResolvedGlanceStyles): string {
	const fullPlain = RESOURCE_LABELS.map(([key, label]) => `${label} ${resourceCount(resources, key)}`).join(" · ");
	const useShort = visibleWidth(fullPlain) > width;
	return RESOURCE_LABELS.map(([key, label, short]) => {
		const name = useShort ? short : label;
		const separator = useShort ? "" : " ";
		return `${styles.dim(name)}${separator}${styles.text(resourceCount(resources, key))}`;
	}).join(styles.dim(" · "));
}

function commandRows(commandTips: readonly string[]): string[] {
	if (commandTips.length <= 2) return [commandTips.join(" · ")];
	const split = Math.ceil(commandTips.length / 2);
	return [commandTips.slice(0, split).join(" · "), commandTips.slice(split).join(" · ")];
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
		const tagline = styles.dim(STARTUP_TAGLINE);
		const tipTitle = this.theme.bold(styles.title("Getting started"));
		const commandsTitle = this.theme.bold(styles.title("Commands"));
		const prompt = styles.dim(STARTUP_PROMPT);
		const versionLabel = `${styles.title("Pi")} ${styles.text(`v${info.version}`)}`;

		if (safeWidth < MIN_BOX_WIDTH) {
			const compactBrand = this.theme.bold(styles.title("◌ Pi · Glance"));
			const lines = [fitLine(compactBrand, safeWidth, safeWidth > 1 ? "…" : "")];
			if (safeWidth >= 12) lines.push(fitLine(styles.dim(this.options.commandTips.join(" · ")), safeWidth, "…"));
			if (safeWidth >= 16) lines.push(fitLine(renderResourceSummary(info.resources, safeWidth, styles), safeWidth, "…"));
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
				center(tagline, widths.leftWidth),
				"",
				"",
			];
			const divider = styles.border("─".repeat(Math.max(8, Math.min(widths.rightWidth, 22))));
			const rightLines = [
				"",
				tipTitle,
				prompt,
				divider,
				commandsTitle,
				...this.options.commandTips.map((command) => styles.dim(command)),
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
			const body = [
				...logo.map((line) => center(line, innerWidth)),
				center(brand, innerWidth),
				center(tagline, innerWidth),
				tipTitle,
				prompt,
				styles.border("─".repeat(Math.max(8, Math.min(innerWidth, 22)))),
				commandsTitle,
				...commandRows(this.options.commandTips).map((line) => styles.dim(line)),
			];
			for (const line of body) lines.push(boxedLine(fitLine(line, innerWidth, "…"), safeWidth, styles));
		}

		lines.push(sectionBorder(safeWidth, "Resources", styles));
		lines.push(boxedLine(fitLine(renderResourceSummary(info.resources, innerWidth, styles), innerWidth, "…"), safeWidth, styles));
		lines.push(bottomBorder(safeWidth, styles));
		return lines.map((line) => fitLine(line, safeWidth));
	}
}
