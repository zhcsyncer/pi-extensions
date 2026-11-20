import assert from "node:assert/strict";
import test from "node:test";
import { hasPromptZoneMarker } from "../src/prompt-zone-markers.ts";
import { fullscreen } from "./helpers/aggregate-terminal.ts";

const BEL = "\x1b]133;A\x07";
const ST = "\x1b]133;A\x1b\\";

test("hasPromptZoneMarker finds the row pi-tui would stop on", () => {
	assert.equal(hasPromptZoneMarker([]), false);
	assert.equal(hasPromptZoneMarker([""]), false);
	assert.equal(hasPromptZoneMarker([BEL]), true);
	assert.equal(hasPromptZoneMarker([`${BEL}\x1b[49m styled`]), true);
	assert.equal(hasPromptZoneMarker([ST + "styled"]), true);
	assert.equal(hasPromptZoneMarker(["", BEL]), true, "a leading blank row does not hide the boundary");
	assert.equal(hasPromptZoneMarker(["plain", "", BEL, "tail"]), true);
	assert.equal(hasPromptZoneMarker(["\x1b]133;B\x07\x1b]133;C\x07tail"]), false);
});

test("hasPromptZoneMarker stays anchored so quoted bytes never invent a boundary", () => {
	assert.equal(hasPromptZoneMarker(["literal \x1b]133;A\x07 inside text"]), false);
	assert.equal(hasPromptZoneMarker(["\x1b[49m\x1b]133;A\x07 not at byte 0"]), false);
	assert.equal(hasPromptZoneMarker(["\x1b]133;A;params\x07no terminator after A"]), false);
	assert.equal(hasPromptZoneMarker(["\x1b]133;a\x07lowercase is not pi's marker"]), false);
});

test("the predicate agrees with the installed Pi fullscreen prompt navigator", () => {
	const cases: Array<{ lines: string[]; stop?: number }> = [
		{ lines: [] },
		{ lines: [""] },
		{ lines: [BEL + "body"], stop: 1 },
		{ lines: [ST + "body"], stop: 1 },
		{ lines: [BEL + "\x1b[49mstyled"], stop: 1 },
		{ lines: ["", "", BEL + "shifted"], stop: 3 },
		{ lines: ["unmarked", ST + "later row"], stop: 2 },
		{ lines: ["quoting " + BEL + " in text"] },
		{ lines: ["\x1b[49m" + BEL + "after style"] },
		{ lines: ["\x1b]133;A;params\x07not a prompt"] },
		{ lines: ["\x1b]133;B\x07\x1b]133;C\x07tail"] },
		{ lines: ["\x1b]133;A"] },
	];
	for (const { lines, stop } of cases) {
		const f = fullscreen({ follow: "none" });
		f.document.addChild({ render: () => ["before", ...lines, ...Array<string>(30).fill("tail")], invalidate() {} });
		try {
			f.start();
			f.scroll.scrollToStart(); f.paint();
			// Exercise the real consumer rather than restating its regex as a test oracle.
			(f.renderer as unknown as { scrollToPrompt(direction: -1 | 1): void }).scrollToPrompt(1);
			f.paint();
			assert.equal(f.scroll.scrollTop, stop ?? 0);
			assert.equal(hasPromptZoneMarker(lines), f.scroll.scrollTop !== 0);
		} finally { f.stop(); }
	}
});
