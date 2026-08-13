import { visibleWidth } from "@earendil-works/pi-tui";
import type { ResolvedGlanceStyles } from "./theme-adapter.js";
import { isWorkingStalled, type WorkingIndicatorSnapshot, workingOutputTokens } from "./working-indicator-state.js";

export const WORKING_SPINNER_GLYPHS = ["·", "✢", "✱", "✶", "✻", "✽", "✻", "✶", "✱", "✢"] as const;
export const WORKING_SPINNER_INTERVAL_MS = 120;

const SHIMMER_STEP_MS = 90;
const ELLIPSIS = "…";

export interface WorkingRenderInput {
	readonly snapshot: WorkingIndicatorSnapshot;
	readonly nowMs: number;
	readonly width: number;
	readonly styles: ResolvedGlanceStyles;
}

export function safeWorkingSpinnerGlyphs(glyphs: readonly string[] = WORKING_SPINNER_GLYPHS): string[] {
	return glyphs.map((glyph) => (visibleWidth(glyph) === 1 ? glyph : "*"));
}

export function styledWorkingSpinnerFrames(styles: ResolvedGlanceStyles): string[] {
	return safeWorkingSpinnerGlyphs().map((glyph) => styles.title(glyph));
}

export function splitGraphemes(text: string): string[] {
	const Segmenter = Intl.Segmenter;
	if (typeof Segmenter === "function") {
		return [...new Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
	}
	return Array.from(text);
}

function shimmerVerb(snapshot: WorkingIndicatorSnapshot, nowMs: number, styles: ResolvedGlanceStyles, stalled: boolean): string {
	const verb = `${snapshot.verb}${ELLIPSIS}`;
	const graphemes = splitGraphemes(verb);
	if (graphemes.length === 0) return "";
	const columns = graphemes.map((grapheme) => Math.max(1, visibleWidth(grapheme)));
	const totalColumns = columns.reduce((sum, width) => sum + width, 0);
	const rawPosition = Math.floor(Math.max(0, nowMs - snapshot.startedAtMs) / SHIMMER_STEP_MS) % Math.max(1, totalColumns);
	const leftToRight = snapshot.phase === "requesting";
	const position = leftToRight ? rawPosition : totalColumns - 1 - rawPosition;
	let cursor = 0;
	return graphemes
		.map((grapheme, index) => {
			const start = cursor;
			cursor += columns[index]!;
			const highlighted = position >= start && position < cursor;
			if (stalled) return styles.error(grapheme);
			return highlighted ? styles.text(grapheme) : styles.title(grapheme);
		})
		.join("");
}

function activityText(snapshot: WorkingIndicatorSnapshot): string | undefined {
	if (snapshot.phase === "thinking") {
		return snapshot.thinkingEffort ? `thinking with ${snapshot.thinkingEffort} effort` : "thinking";
	}
	if (snapshot.phase === "tool-use") {
		if (snapshot.tools.length === 1) return `running ${snapshot.tools[0]!.name}`;
		if (snapshot.tools.length > 1) return `running ${snapshot.tools.length} tools`;
	}
	if (snapshot.phase === "requesting" && (snapshot.finalizedOutput > 0 || snapshot.hasGenerationProgress)) return "requesting";
	return undefined;
}

function tokenText(snapshot: WorkingIndicatorSnapshot): string | undefined {
	const output = workingOutputTokens(snapshot);
	if (output <= 0 && !snapshot.hasPartialEstimate) return undefined;
	return `↓ ${snapshot.hasPartialEstimate ? "~" : ""}${output.toLocaleString("en-US")} ${output === 1 ? "token" : "tokens"}`;
}

function elapsedText(snapshot: WorkingIndicatorSnapshot, nowMs: number): string {
	return `${Math.max(0, Math.floor((nowMs - snapshot.startedAtMs) / 1000))}s`;
}

function renderDetails(details: readonly string[], styles: ResolvedGlanceStyles): string {
	return styles.dim(` (${details.join(" · ")})`);
}

function truncatePlain(text: string, width: number): string {
	if (width <= 0) return "";
	let output = "";
	for (const grapheme of splitGraphemes(text)) {
		if (visibleWidth(output + grapheme) > width) break;
		output += grapheme;
	}
	return output;
}

function truncateVerb(snapshot: WorkingIndicatorSnapshot, nowMs: number, styles: ResolvedGlanceStyles, stalled: boolean, width: number): string {
	const plain = truncatePlain(`${snapshot.verb}${ELLIPSIS}`, Math.max(0, width));
	if (!plain) return "";
	const graphemes = splitGraphemes(plain);
	const columns = graphemes.map((grapheme) => Math.max(1, visibleWidth(grapheme)));
	const totalColumns = columns.reduce((sum, columnWidth) => sum + columnWidth, 0);
	const rawPosition = Math.floor(Math.max(0, nowMs - snapshot.startedAtMs) / SHIMMER_STEP_MS) % totalColumns;
	const position = snapshot.phase === "requesting" ? rawPosition : totalColumns - 1 - rawPosition;
	let cursor = 0;
	return graphemes
		.map((grapheme, index) => {
			const start = cursor;
			cursor += columns[index]!;
			return stalled ? styles.error(grapheme) : position >= start && position < cursor ? styles.text(grapheme) : styles.title(grapheme);
		})
		.join("");
}

export function renderWorkingMessage(input: WorkingRenderInput): string {
	const { snapshot, nowMs, styles } = input;
	const width = Math.max(1, Math.floor(input.width));
	if (!snapshot.active) return "";
	const stalled = isWorkingStalled(snapshot, nowMs);
	const verb = shimmerVerb(snapshot, nowMs, styles, stalled);
	const activity = activityText(snapshot);
	const tokens = tokenText(snapshot);
	const elapsed = !activity && !tokens ? undefined : elapsedText(snapshot, nowMs);
	const detailVariants = [
		[activity, tokens, elapsed],
		[activity, tokens],
		[activity],
		[],
	].map((parts) => parts.filter((part): part is string => Boolean(part)));

	for (const details of detailVariants) {
		const candidate = `${verb}${details.length > 0 ? renderDetails(details, styles) : ""}`;
		if (visibleWidth(candidate) <= width) return candidate;
	}
	return truncateVerb(snapshot, nowMs, styles, stalled, width);
}
