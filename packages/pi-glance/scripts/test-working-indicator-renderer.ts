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
	error: "\u001b[35m",
	title: "\u001b[34m",
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

assert.deepEqual(WORKING_SPINNER_GLYPHS, ["·", "✢", "✱", "✶", "✻", "✽", "✻", "✶", "✱", "✢"], "spinner should preserve non-repeated ping-pong endpoints");
assert.ok(safeWorkingSpinnerGlyphs().every((glyph) => visibleWidth(glyph) === 1), "every spinner frame should be exactly one visible column");
assert.deepEqual(safeWorkingSpinnerGlyphs(["✢", "ab", "🧪"]), ["✢", "*", "*"], "unsafe-width spinner glyphs should fall back to one-column stars");
assert.ok(styledWorkingSpinnerFrames(styles).every((frame) => frame.includes(STYLE_CODES.title!)), "spinner frames should use resolved title styling");

assert.deepEqual(splitGraphemes("A👩‍💻e\u0301"), ["A", "👩‍💻", "é"], "grapheme segmentation should preserve emoji ZWJ and combining sequences");
const unicode = renderWorkingMessage({ snapshot: snapshot({ verb: "👩‍💻e\u0301" }), nowMs: 0, width: 80, styles });
assert.ok(unicode.includes("👩‍💻") && unicode.includes("é"), "shimmer should preserve complete graphemes in visible output");
assert.equal(unicode.includes("�"), false, "shimmer should never emit broken Unicode replacement glyphs");

const firstRequest = snapshot({ phase: "requesting", finalizedOutput: 0, hasGenerationProgress: false });
const requestingAtStart = renderWorkingMessage({ snapshot: firstRequest, nowMs: 0, width: 80, styles });
const requestingLater = renderWorkingMessage({ snapshot: firstRequest, nowMs: 90, width: 80, styles });
assert.notEqual(requestingAtStart, requestingLater, "requesting shimmer should move left to right with elapsed time");
assert.equal(requestingAtStart.includes("("), false, "first requesting state with no other facts should show only the main phrase");
assert.ok(requestingAtStart.includes(`${STYLE_CODES.text}B`), "requesting shimmer should begin on the leftmost grapheme");
const respondingAtStart = renderWorkingMessage({ snapshot: snapshot(), nowMs: 0, width: 80, styles });
assert.ok(respondingAtStart.includes(`${STYLE_CODES.text}…`), "generating shimmer should begin on the rightmost grapheme");
assert.ok(respondingAtStart.includes(STYLE_CODES.title!), "verb base should use resolved title style");
assert.ok(respondingAtStart.includes(STYLE_CODES.text!), "verb highlight should use resolved text style");
assert.ok(respondingAtStart.includes(STYLE_CODES.dim!), "activity/token/elapsed details should use resolved dim style");

const estimated = renderWorkingMessage({ snapshot: snapshot({ partialOutput: 42, hasPartialEstimate: true }), nowMs: 2_000, width: 80, styles });
assert.ok(estimated.includes("↓ ~226 tokens"), "partial output should add to finalized output and show an estimate marker");
const finalized = renderWorkingMessage({ snapshot: snapshot(), nowMs: 2_000, width: 80, styles });
assert.ok(finalized.includes("↓ 184 tokens"), "finalized output should omit the estimate marker");
assert.equal(finalized.includes("~184"), false, "finalized tokens should never retain a tilde");

const tool = snapshot({ phase: "tool-use", tools: [{ id: "a", name: "bash" }] });
const wide = renderWorkingMessage({ snapshot: tool, nowMs: 18_000, width: 80, styles });
assert.ok(wide.includes("running bash") && wide.includes("↓ 184 tokens") && wide.includes("18s"), "wide output should include activity, token and elapsed details");
const withoutElapsed = renderWorkingMessage({ snapshot: tool, nowMs: 18_000, width: visibleWidth(wide) - 3, styles });
assert.equal(withoutElapsed.includes("18s"), false, "elapsed should be the first detail removed as width narrows");
assert.ok(withoutElapsed.includes("running bash") && withoutElapsed.includes("↓ 184 tokens"), "activity and tokens should survive before elapsed");
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
