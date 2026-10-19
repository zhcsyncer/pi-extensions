import assert from "node:assert/strict";
import test from "node:test";
import { hasPromptZoneMarker } from "../src/prompt-zone-markers.ts";

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
