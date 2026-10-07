import assert from "node:assert/strict";
import test from "node:test";
import {
  OSC133_ZONE_END,
  OSC133_ZONE_FINAL,
  OSC133_ZONE_START,
  hasPromptZoneStart,
  markPromptZone,
  stripPromptZone,
} from "../src/prompt-zone-markers.ts";

const ST_START = "\x1b]133;A\x1b\\";
const ST_END = "\x1b]133;B\x1b\\";
const ST_FINAL = "\x1b]133;C\x1b\\";

// ===========================================================================
// markPromptZone
// ===========================================================================

test("markPromptZone returns an empty array for empty input", () => {
  assert.deepEqual(markPromptZone([]), []);
});

test("markPromptZone prefixes A to the first row and B+C to the last row", () => {
  assert.deepEqual(markPromptZone(["one", "two", "three"]), [
    OSC133_ZONE_START + "one",
    "two",
    OSC133_ZONE_END + OSC133_ZONE_FINAL + "three",
  ]);
});

test("markPromptZone on a single row still starts with the A marker", () => {
  const marked = markPromptZone(["only"]);
  assert.equal(marked.length, 1);
  assert.ok(marked[0].startsWith(OSC133_ZONE_START));
  assert.ok(hasPromptZoneStart(marked));
});

test("markPromptZone does not mutate its input", () => {
  const input = ["one", "two"];
  markPromptZone(input);
  assert.deepEqual(input, ["one", "two"]);
});

test("markPromptZone round-trips through stripPromptZone", () => {
  const rows = ["one", "two", "three"];
  assert.deepEqual(stripPromptZone(markPromptZone(rows)), rows);
});

// ===========================================================================
// stripPromptZone
// ===========================================================================

test("stripPromptZone removes BEL and ST terminated leading runs from both edges", () => {
  assert.deepEqual(
    stripPromptZone([
      OSC133_ZONE_START + "one",
      "two",
      OSC133_ZONE_END + OSC133_ZONE_FINAL + "three",
    ]),
    ["one", "two", "three"],
  );
  assert.deepEqual(
    stripPromptZone([ST_START + "one", ST_END + ST_FINAL + "two"]),
    ["one", "two"],
  );
});

test("stripPromptZone removes a stacked run on a single row", () => {
  assert.deepEqual(
    stripPromptZone([OSC133_ZONE_START + OSC133_ZONE_END + OSC133_ZONE_FINAL + "only"]),
    ["only"],
  );
});

test("stripPromptZone does not mutate its input and leaves unmarked rows alone", () => {
  const input = ["plain", "rows"];
  assert.deepEqual(stripPromptZone(input), ["plain", "rows"]);
  assert.deepEqual(input, ["plain", "rows"]);
});

// ===========================================================================
// hasPromptZoneStart
// ===========================================================================

test("hasPromptZoneStart detects BEL and ST terminated A markers", () => {
  assert.equal(hasPromptZoneStart([OSC133_ZONE_START + "x"]), true);
  assert.equal(hasPromptZoneStart([ST_START + "x"]), true);
});

test("hasPromptZoneStart ignores B/C-only rows, offset markers and empty input", () => {
  assert.equal(hasPromptZoneStart([]), false);
  assert.equal(hasPromptZoneStart([OSC133_ZONE_END + OSC133_ZONE_FINAL + "x"]), false);
  assert.equal(hasPromptZoneStart(["  " + OSC133_ZONE_START + "x"]), false);
});
