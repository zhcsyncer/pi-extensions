import { strict as assert } from "node:assert";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ResolvedGlanceStyles, TextStyler } from "../theme-adapter.js";
import {
	renderWorkingMessage,
	safeWorkingSpinnerGlyphs,
	splitGraphemes,
	styledWorkingSpinnerFrames,
	WORKING_SPINNER_GLYPHS,
} from "../working-indicator-renderer.js";
import type { WorkingIndicatorSnapshot } from "../working-indicator-state.js";

const STYLE_CODES: Record<string, string> = {
	text: "\u001b[31m",
	dim: "\u001b[2m",
	warn: "\u001b[33m",
	error: "\u001b[35m",
	title: "\u001b[34m",
	strongTitle: "\u001b[1;34m",
};

function marker(name: string): TextStyler {
	return (text) => `${STYLE_CODES[name] ?? "\u001b[36m"}${text}\u001b[39m`;
}

const styles: ResolvedGlanceStyles = {
	source: "glance",
	themeId: "test",
	label: "Test",
	cacheKey: "glance:test",
	text: marker("text"),
	strongTitle: marker("strongTitle"),
	dim: marker("dim"),
	success: marker("success"),
	warn: marker("warn"),
	error: marker("error"),
	separator: marker("separator"),
	border: marker("border"),
	bashBorder: marker("bash"),
	title: marker("title"),
	segments: Object.fromEntries(["git", "model", "context", "tokens", "cost", "throughput"].map((id) => [id, { fg: marker(id) }])) as ResolvedGlanceStyles["segments"],
};

function snapshot(overrides: Partial<WorkingIndicatorSnapshot> = {}): WorkingIndicatorSnapshot {
	return {
		active: true,
		phase: "responding",
		verb: "Brewing",
		startedAtMs: 0,
		finalizedOutput: 184,
		partialOutput: 0,
		hasPartialEstimate: false,
		lastProgressAtMs: 0,
		hasGenerationProgress: true,
		tools: [],
		...overrides,
	};
}

assert.deepEqual(
	WORKING_SPINNER_GLYPHS,
	["·", "·", "✢", "✢", "✱", "✶", "✻", "✽", "✽", "✽", "✽", "✻", "✶", "✱", "✢", "✢", "·"],
	"spinner should use an eased ping-pong sequence with deliberate endpoint dwell",
);
assert.equal(WORKING_SPINNER_GLYPHS.length * 120, 2_040, "spinner cycle should stay close to Claude Code's calmer two-second rhythm");
assert.ok(safeWorkingSpinnerGlyphs().every((glyph) => visibleWidth(glyph) === 1), "every spinner frame should be exactly one visible column");
assert.deepEqual(safeWorkingSpinnerGlyphs(["✢", "ab", "🧪"]), ["✢", "*", "*"], "unsafe-width spinner glyphs should fall back to one-column stars");
assert.ok(styledWorkingSpinnerFrames(styles).every((frame) => frame.includes(STYLE_CODES.title!)), "spinner frames should use resolved title styling");

assert.deepEqual(splitGraphemes("A👩‍💻e\u0301"), ["A", "👩‍💻", "é"], "grapheme segmentation should preserve emoji ZWJ and combining sequences");
const unicode = renderWorkingMessage({ snapshot: snapshot({ verb: "👩‍💻e\u0301" }), nowMs: 0, width: 80, styles });
assert.ok(unicode.includes("👩‍💻") && unicode.includes("é"), "shimmer should preserve complete graphemes in visible output");
assert.equal(unicode.includes("�"), false, "shimmer should never emit broken Unicode replacement glyphs");

const firstRequest = snapshot({ phase: "requesting", finalizedOutput: 0, hasGenerationProgress: false });
const requestingAtStart = renderWorkingMessage({ snapshot: firstRequest, nowMs: 0, width: 80, styles });
const requestingStillOffscreen = renderWorkingMessage({ snapshot: firstRequest, nowMs: 960, width: 80, styles });
const requestingShoulderEntry = renderWorkingMessage({ snapshot: firstRequest, nowMs: 1_080, width: 80, styles });
const requestingEntry = renderWorkingMessage({ snapshot: firstRequest, nowMs: 1_200, width: 80, styles });
const requestingNext = renderWorkingMessage({ snapshot: firstRequest, nowMs: 1_320, width: 80, styles });
assert.equal(requestingAtStart, requestingStillOffscreen, "requesting shimmer should begin with a calm offscreen lead-in");
assert.ok(requestingShoulderEntry.includes(`${STYLE_CODES.title}B`), "requesting shimmer shoulder should enter before its center");
assert.notEqual(requestingEntry, requestingNext, "requesting shimmer should move left to right one visible column per ticker frame");
assert.equal(requestingAtStart.includes("("), false, "first requesting state with no other facts should show only the main phrase");
assert.equal(requestingAtStart, styles.text("Brewing…"), "offscreen shimmer should leave the whole verb in normal text color");
assert.ok(requestingEntry.includes(`${STYLE_CODES.strongTitle}B`), "requesting shimmer center should enter on the left in bold accent");
assert.ok(requestingNext.includes(`${STYLE_CODES.title}B`) && requestingNext.includes(`${STYLE_CODES.strongTitle}r`), "shimmer shoulders should retain accent around its bold center");
const respondingOffscreen = renderWorkingMessage({ snapshot: snapshot(), nowMs: 0, width: 80, styles });
const respondingShoulderEntry = renderWorkingMessage({ snapshot: snapshot(), nowMs: 2_400, width: 80, styles });
const respondingEntry = renderWorkingMessage({ snapshot: snapshot(), nowMs: 2_640, width: 80, styles });
const respondingNext = renderWorkingMessage({ snapshot: snapshot(), nowMs: 2_880, width: 80, styles });
assert.ok(respondingShoulderEntry.includes(`${STYLE_CODES.title}…`), "generating shimmer shoulder should enter from the right");
assert.ok(respondingEntry.includes(`${STYLE_CODES.strongTitle}…`), "generating shimmer center should enter on the right");
assert.ok(respondingNext.includes(`${STYLE_CODES.strongTitle}g`), "generating shimmer should move right to left at the slower cadence");
assert.equal(respondingOffscreen.includes(STYLE_CODES.title!), false, "offscreen generating shimmer should preserve the normal text base");
assert.ok(respondingEntry.includes(STYLE_CODES.title!), "visible shimmer shoulders should use resolved title style");
assert.ok(respondingEntry.includes(STYLE_CODES.strongTitle!), "visible shimmer center should use resolved strong title style");
assert.ok(respondingEntry.includes(STYLE_CODES.text!), "verb base should use resolved text style");
assert.ok(respondingEntry.includes(STYLE_CODES.dim!), "activity/token/elapsed details should use resolved dim style");

const estimated = renderWorkingMessage({ snapshot: snapshot({ partialOutput: 42, hasPartialEstimate: true }), nowMs: 2_000, width: 80, styles });
assert.ok(estimated.includes("↓ ~226 tokens"), "partial output should add to finalized output and show an estimate marker");
const noFacts = snapshot({ finalizedOutput: 0, partialOutput: 0, hasPartialEstimate: false, hasGenerationProgress: false });
const emptyPartial = renderWorkingMessage({ snapshot: noFacts, nowMs: 2_000, width: 80, styles });
assert.equal(emptyPartial.includes("token"), false, "an empty partial should not render a meaningless zero-token estimate");
assert.equal(emptyPartial.includes("2s"), false, "a short empty partial should preserve the main-phrase-only state");
const minuteWithoutFacts = renderWorkingMessage({ snapshot: noFacts, nowMs: 60_000, width: 80, styles });
assert.ok(minuteWithoutFacts.includes(styles.text("1m 00s")), "a one-minute cycle should surface elapsed time even without activity or token details");
const almostLong = renderWorkingMessage({ snapshot: noFacts, nowMs: 299_999, width: 80, styles });
assert.ok(almostLong.includes(styles.text("4m 59s")), "elapsed time before five minutes should use normal text emphasis");
const longWithoutFacts = renderWorkingMessage({ snapshot: noFacts, nowMs: 300_000, width: 80, styles });
assert.ok(longWithoutFacts.includes(styles.warn("5m 00s")), "elapsed time at five minutes should use warning emphasis");
const humanizedLong = renderWorkingMessage({ snapshot: noFacts, nowMs: 1_155_000, width: 80, styles });
assert.ok(humanizedLong.includes(styles.warn("19m 15s")), "long minute elapsed time should remain human-readable");
const hourWithoutSeconds = renderWorkingMessage({ snapshot: noFacts, nowMs: 4_023_000, width: 80, styles });
assert.ok(hourWithoutSeconds.includes(styles.warn("1h 07m")), "hour elapsed time should omit low-value seconds");
const finalized = renderWorkingMessage({ snapshot: snapshot(), nowMs: 2_000, width: 80, styles });
assert.ok(finalized.includes("↓ 184 tokens"), "finalized output should omit the estimate marker");
assert.equal(finalized.includes("~184"), false, "finalized tokens should never retain a tilde");

const tool = snapshot({ phase: "tool-use", tools: [{ id: "a", name: "bash" }] });
const toolAtStart = renderWorkingMessage({ snapshot: tool, nowMs: 0, width: 80, styles });
const wide = renderWorkingMessage({ snapshot: tool, nowMs: 18_000, width: 80, styles });
assert.equal(toolAtStart.replace(/0s/g, "18s"), wide, "tool-use verb should remain static instead of adding shimmer or breathing motion");
assert.ok(wide.includes(styles.text("Brewing…")), "tool-use verb should use normal text styling");
assert.equal(wide.includes(STYLE_CODES.title!), false, "tool-use should not compete with the visible tool call using animated accent text");
assert.ok(wide.includes("running bash") && wide.includes("↓ 184 tokens") && wide.includes("18s"), "wide output should include activity, token and elapsed details");
const withoutElapsed = renderWorkingMessage({ snapshot: tool, nowMs: 18_000, width: visibleWidth(wide) - 3, styles });
assert.equal(withoutElapsed.includes("18s"), false, "short elapsed time should be the first detail removed as width narrows");
assert.ok(withoutElapsed.includes("running bash") && withoutElapsed.includes("↓ 184 tokens"), "activity and tokens should survive before short elapsed time");
const longNarrow = renderWorkingMessage({ snapshot: tool, nowMs: 300_000, width: 36, styles });
assert.ok(longNarrow.includes("running bash") && longNarrow.includes("5m 00s"), "narrow output should retain activity and warning elapsed time");
assert.equal(longNarrow.includes("token"), false, "warning elapsed time should outlive cycle tokens as width narrows");
assert.ok(visibleWidth(longNarrow) <= 36, "warning elapsed fallback should respect its width budget");
for (const width of [1, 2, 3, 5, 8, 12, 20, 40]) {
	const output = renderWorkingMessage({ snapshot: tool, nowMs: 18_000, width, styles });
	assert.ok(visibleWidth(output) <= width, `working message must fit a ${width}-column budget`);
}

const notStalled = renderWorkingMessage({ snapshot: snapshot({ lastProgressAtMs: 1_000 }), nowMs: 10_999, width: 80, styles });
assert.equal(notStalled.includes(STYLE_CODES.error!), false, "normal responding before threshold should not use stall color");
const stalled = renderWorkingMessage({ snapshot: snapshot({ lastProgressAtMs: 1_000 }), nowMs: 11_000, width: 80, styles });
assert.ok(stalled.includes(STYLE_CODES.error!), "safe responding stall should use resolved error styling");
const thinking = renderWorkingMessage({ snapshot: snapshot({ phase: "thinking", lastProgressAtMs: 0 }), nowMs: 99_000, width: 80, styles });
assert.equal(thinking.includes(STYLE_CODES.error!), false, "thinking should never use stall styling");

console.log("✓ working indicator renderer checks passed");
