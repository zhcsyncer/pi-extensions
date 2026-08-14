import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { resolveGlanceRenderStyles, type GlanceRenderStyleContext, type ResolvedGlanceStyles, type TextStyler } from "./theme-adapter.js";
import type { GitSnapshot, GlanceConfig, GlanceState, WorktreeSummaryMode } from "./types.js";

export const WORKTREE_WIDGET_KEY = "pi-glance-working-tree";
const SEPARATOR = " · ";
const REVIEW_GAP = "    ";
const BAR_CELL = "━";

type SummaryRole = "git" | "text" | "dim" | "separator" | "success" | "error" | "warn";

interface SummaryPart {
	role: SummaryRole;
	text: string;
}

type SummaryCandidate = SummaryPart[];

function styler(styles: ResolvedGlanceStyles, role: SummaryRole): TextStyler {
	switch (role) {
		case "git":
			return styles.segments.git.fg;
		case "text":
			return styles.text;
		case "dim":
			return styles.dim;
		case "separator":
			return styles.separator;
		case "success":
			return styles.success;
		case "error":
			return styles.error;
		case "warn":
			return styles.warn;
	}
}

function renderParts(parts: readonly SummaryPart[], styles: ResolvedGlanceStyles): string {
	return parts.map((part) => styler(styles, part.role)(part.text)).join("");
}

function partsWidth(parts: readonly SummaryPart[]): number {
	return parts.reduce((width, part) => width + visibleWidth(part.text), 0);
}

function chooseCandidate(candidates: readonly SummaryCandidate[], width: number, styles: ResolvedGlanceStyles): string {
	if (width <= 0) return "";
	for (const candidate of candidates) {
		if (partsWidth(candidate) <= width) return renderParts(candidate, styles);
	}
	const fallback = candidates.at(-1) ?? [];
	return truncateToWidth(renderParts(fallback, styles), width, "");
}

function separator(): SummaryPart {
	return { role: "separator", text: SEPARATOR };
}

function statsParts(snapshot: GitSnapshot): SummaryPart[] {
	const { additions, deletions } = snapshot.worktree;
	if (additions === null || deletions === null) return [];
	return [
		{ role: "success", text: `+${additions}` },
		{ role: "text", text: " " },
		{ role: "error", text: `−${deletions}` },
	];
}

function fileParts(snapshot: GitSnapshot, withLabel: boolean): SummaryPart[] {
	const files = snapshot.worktree.files;
	return [
		{ role: "git", text: "Δ" },
		{ role: "text", text: ` ${files}${withLabel ? ` ${files === 1 ? "file" : "files"}` : ""}` },
	];
}

function conflictParts(snapshot: GitSnapshot, withLabel: boolean): SummaryPart[] {
	const count = snapshot.worktree.conflicts.length;
	if (count <= 0) return [];
	return [
		{ role: "warn", text: "!" },
		{ role: "error", text: ` ${count}${withLabel ? ` ${count === 1 ? "conflict" : "conflicts"}` : ""}` },
	];
}

function appendStats(base: SummaryPart[], snapshot: GitSnapshot): SummaryPart[] {
	const stats = statsParts(snapshot);
	return stats.length > 0 ? [...base, separator(), ...stats] : base;
}

export function worktreeInlineCandidates(snapshot: GitSnapshot): SummaryCandidate[] {
	if (!snapshot.repo) return [[]];
	if (snapshot.status === "clean") {
		return [
			[{ role: "git", text: "Δ" }, { role: "dim", text: " clean" }],
			[{ role: "dim", text: "clean" }],
			[],
		];
	}

	const fullFiles = fileParts(snapshot, true);
	const compactFiles = fileParts(snapshot, false);
	const fullConflicts = conflictParts(snapshot, true);
	const compactConflicts = conflictParts(snapshot, false);
	if (fullConflicts.length > 0) {
		return [
			appendStats([...fullConflicts, separator(), ...fullFiles], snapshot),
			appendStats([...compactConflicts, separator(), ...compactFiles], snapshot),
			[...compactConflicts, separator(), ...compactFiles],
			compactConflicts,
		];
	}
	return [appendStats(fullFiles, snapshot), appendStats(compactFiles, snapshot), compactFiles];
}

export function renderWorktreeInline(snapshot: GitSnapshot, width: number, styles: ResolvedGlanceStyles): string {
	return chooseCandidate(worktreeInlineCandidates(snapshot), width, styles);
}

function aboveTitle(snapshot: GitSnapshot, withFiles: boolean): SummaryPart[] {
	const title: SummaryPart[] = [
		{ role: "git", text: "● Working tree" },
	];
	if (snapshot.status === "clean") return [...title, separator(), { role: "dim", text: "clean" }];
	const conflicts = conflictParts(snapshot, withFiles);
	if (conflicts.length > 0) title.push(separator(), ...conflicts);
	title.push(separator(), { role: "text", text: `${snapshot.worktree.files}${withFiles ? ` ${snapshot.worktree.files === 1 ? "file" : "files"}` : ""}` });
	return title;
}

function withReview(parts: SummaryPart[]): SummaryPart[] {
	return [...parts, { role: "separator", text: REVIEW_GAP }, { role: "dim", text: "/diff" }];
}

function aboveCompactCandidates(snapshot: GitSnapshot): SummaryCandidate[] {
	if (snapshot.status === "clean") {
		return [withReview(aboveTitle(snapshot, true)), aboveTitle(snapshot, true), [{ role: "git", text: "● Working tree" }], []];
	}
	const wide = appendStats(aboveTitle(snapshot, true), snapshot);
	const compact = appendStats(aboveTitle(snapshot, false), snapshot);
	return [withReview(wide), withReview(compact), wide, compact];
}

function renderDetailedStats(snapshot: GitSnapshot, width: number, styles: ResolvedGlanceStyles): string {
	if (width <= 0) return "";
	if (snapshot.status === "clean") return truncateToWidth(styles.dim("No changes"), width, "");
	const { additions, deletions } = snapshot.worktree;
	if (additions === null || deletions === null) return truncateToWidth(styles.dim("Line statistics unavailable"), width, "");

	const labelParts = statsParts(snapshot);
	const labelWidth = partsWidth(labelParts);
	const availableBarWidth = Math.max(0, Math.min(24, width - labelWidth - 2));
	if (availableBarWidth < 3) return chooseCandidate([labelParts, []], width, styles);
	const total = additions + deletions;
	let additionCells = total > 0 ? Math.round((additions / total) * availableBarWidth) : 0;
	if (additions > 0) additionCells = Math.max(1, additionCells);
	if (deletions > 0) additionCells = Math.min(availableBarWidth - 1, additionCells);
	const deletionCells = availableBarWidth - additionCells;
	const bar = total === 0
		? styles.separator(BAR_CELL.repeat(availableBarWidth))
		: `${styles.success(BAR_CELL.repeat(additionCells))}${styles.error(BAR_CELL.repeat(deletionCells))}`;
	return `${renderParts(labelParts, styles)}  ${bar}`;
}

export function renderAboveWorktreeSummary(
	snapshot: GitSnapshot,
	mode: Extract<WorktreeSummaryMode, "above-compact" | "above-detailed">,
	width: number,
	styles: ResolvedGlanceStyles,
): string[] {
	if (!snapshot.repo || width <= 0) return [];
	if (mode === "above-compact") {
		const line = chooseCandidate(aboveCompactCandidates(snapshot), width, styles);
		return line ? [line] : [];
	}
	const first = chooseCandidate(
		[withReview(aboveTitle(snapshot, true)), withReview(aboveTitle(snapshot, false)), aboveTitle(snapshot, true), aboveTitle(snapshot, false)],
		width,
		styles,
	);
	return [first, renderDetailedStats(snapshot, width, styles)];
}

export function isAboveWorktreeSummary(mode: WorktreeSummaryMode): mode is "above-compact" | "above-detailed" {
	return mode === "above-compact" || mode === "above-detailed";
}

export function isBorderWorktreeSummary(mode: WorktreeSummaryMode): mode is "border-left" | "border-right" {
	return mode === "border-left" || mode === "border-right";
}

export class WorktreeSummaryWidget implements Component {
	constructor(
		private readonly getState: () => GlanceState,
		private readonly getConfig: () => GlanceConfig,
		private readonly renderStyleContext?: GlanceRenderStyleContext,
	) {}

	render(width: number): string[] {
		const config = this.getConfig();
		if (!config.enabled || !isAboveWorktreeSummary(config.git.worktreeSummary)) return [];
		const styles = resolveGlanceRenderStyles(config, this.renderStyleContext);
		return renderAboveWorktreeSummary(this.getState().git, config.git.worktreeSummary, width, styles);
	}

	invalidate(): void {
		// Rendering is intentionally stateless so Pi theme invalidation immediately
		// re-resolves the current color source and theme tokens.
	}
}
