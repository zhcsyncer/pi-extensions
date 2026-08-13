import { visibleWidth } from "@earendil-works/pi-tui";
import type { ResolvedGlanceStyles } from "./theme-adapter.js";
import { isWorkingStalled, type WorkingIndicatorSnapshot, workingOutputTokens } from "./working-indicator-state.js";

export const WORKING_SPINNER_GLYPHS = ["·", "·", "✢", "✢", "✱", "✶", "✻", "✽", "✽", "✽", "✽", "✻", "✶", "✱", "✢", "✢", "·"] as const;
export const WORKING_SPINNER_INTERVAL_MS = 120;

const SHIMMER_EDGE_TRAVEL_COLUMNS = 10;
const REQUESTING_SHIMMER_STEP_MS = WORKING_SPINNER_INTERVAL_MS;
const GENERATING_SHIMMER_STEP_MS = WORKING_SPINNER_INTERVAL_MS * 2;
const ELAPSED_TEXT_THRESHOLD_MS = 60_000;
const ELAPSED_WARNING_THRESHOLD_MS = 5 * 60_000;
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

function shimmerCenter(snapshot: WorkingIndicatorSnapshot, nowMs: number, totalColumns: number): number | undefined {
	if (snapshot.phase === "tool-use") return undefined;
	const stepMs = snapshot.phase === "requesting" ? REQUESTING_SHIMMER_STEP_MS : GENERATING_SHIMMER_STEP_MS;
	const travelColumns = totalColumns + SHIMMER_EDGE_TRAVEL_COLUMNS * 2;
	const rawPosition = Math.floor(Math.max(0, nowMs - snapshot.startedAtMs) / stepMs) % travelColumns;
	return snapshot.phase === "requesting"
		? rawPosition - SHIMMER_EDGE_TRAVEL_COLUMNS
		: totalColumns + SHIMMER_EDGE_TRAVEL_COLUMNS - rawPosition;
}

function renderShimmerText(text: string, snapshot: WorkingIndicatorSnapshot, nowMs: number, styles: ResolvedGlanceStyles, stalled: boolean): string {
	if (!text) return "";
	if (stalled) return styles.error(text);
	const graphemes = splitGraphemes(text);
	const columns = graphemes.map((grapheme) => Math.max(1, visibleWidth(grapheme)));
	const totalColumns = columns.reduce((sum, width) => sum + width, 0);
	const center = shimmerCenter(snapshot, nowMs, totalColumns);
	if (center === undefined || center < -1 || center > totalColumns) return styles.text(text);

	let cursor = 0;
	return graphemes
		.map((grapheme, index) => {
			const start = cursor;
			cursor += columns[index]!;
			if (center >= start && center < cursor) return styles.strongTitle(grapheme);
			const touchesHighlightBand = start < center + 2 && cursor > center - 1;
			return touchesHighlightBand ? styles.title(grapheme) : styles.text(grapheme);
		})
		.join("");
}

function shimmerVerb(snapshot: WorkingIndicatorSnapshot, nowMs: number, styles: ResolvedGlanceStyles, stalled: boolean): string {
	return renderShimmerText(`${snapshot.verb}${ELLIPSIS}`, snapshot, nowMs, styles, stalled);
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

function formatWorkingElapsed(elapsedMs: number): string {
	const safeElapsedMs = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
	const totalSeconds = Math.floor(safeElapsedMs / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m ${seconds.toString().padStart(2, "0")}s`;

	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
}

type DetailTone = "dim" | "text" | "warn";

interface WorkingDetail {
	readonly text: string;
	readonly tone: DetailTone;
}

function renderDetail(detail: WorkingDetail, styles: ResolvedGlanceStyles): string {
	return styles[detail.tone](detail.text);
}

function renderDetails(details: readonly WorkingDetail[], styles: ResolvedGlanceStyles): string {
	return `${styles.dim(" (")}${details.map((detail) => renderDetail(detail, styles)).join(styles.dim(" · "))}${styles.dim(")")}`;
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
	return renderShimmerText(plain, snapshot, nowMs, styles, stalled);
}

export function renderWorkingMessage(input: WorkingRenderInput): string {
	const { snapshot, nowMs, styles } = input;
	const width = Math.max(1, Math.floor(input.width));
	if (!snapshot.active) return "";
	const stalled = isWorkingStalled(snapshot, nowMs);
	const verb = shimmerVerb(snapshot, nowMs, styles, stalled);
	const activityValue = activityText(snapshot);
	const tokenValue = tokenText(snapshot);
	const elapsedMs = Math.max(0, nowMs - snapshot.startedAtMs);
	const showElapsed = Boolean(activityValue || tokenValue) || elapsedMs >= ELAPSED_TEXT_THRESHOLD_MS;
	const elapsedWarning = elapsedMs >= ELAPSED_WARNING_THRESHOLD_MS;
	const activity: WorkingDetail | undefined = activityValue ? { text: activityValue, tone: "dim" } : undefined;
	const tokens: WorkingDetail | undefined = tokenValue ? { text: tokenValue, tone: "dim" } : undefined;
	const elapsed: WorkingDetail | undefined = showElapsed
		? {
				text: formatWorkingElapsed(elapsedMs),
				tone: elapsedWarning ? "warn" : elapsedMs >= ELAPSED_TEXT_THRESHOLD_MS ? "text" : "dim",
			}
		: undefined;
	const detailVariants = [
		[activity, tokens, elapsed],
		elapsedWarning ? [activity, elapsed] : [activity, tokens],
		[activity],
		[],
	].map((parts) => parts.filter((part): part is WorkingDetail => Boolean(part)));

	for (const details of detailVariants) {
		const candidate = `${verb}${details.length > 0 ? renderDetails(details, styles) : ""}`;
		if (visibleWidth(candidate) <= width) return candidate;
	}
	return truncateVerb(snapshot, nowMs, styles, stalled, width);
}
