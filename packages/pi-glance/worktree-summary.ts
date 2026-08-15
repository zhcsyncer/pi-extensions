import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ResolvedGlanceStyles, TextStyler } from "./theme-adapter.js";
import type { GitSnapshot, WorktreeSummaryMode } from "./types.js";

export const WORKTREE_WIDGET_KEY = "pi-glance-working-tree";
const SEPARATOR = " · ";

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

export function isBorderWorktreeSummary(mode: WorktreeSummaryMode): mode is "border-right" {
	return mode === "border-right";
}
