import assert from "node:assert/strict";
import test from "node:test";
import {
  applyToolDisplayMode,
  detectToolDisplayMode,
  getToolResultModeConfig,
  parseToolDisplayMode,
} from "../src/presets.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

test("result mode parsing accepts final names and legacy aliases", () => {
  assert.equal(parseToolDisplayMode(" SUMMARY "), "summary");
  assert.equal(parseToolDisplayMode("Preview"), "preview");
  assert.equal(parseToolDisplayMode("Verbose"), "preview");
  assert.equal(parseToolDisplayMode("Detailed"), "preview");
  assert.equal(parseToolDisplayMode("Balanced"), "summary");
  assert.equal(parseToolDisplayMode("OpenCode"), "compact");
  assert.equal(parseToolDisplayMode("minimal"), "compact");
  assert.equal(parseToolDisplayMode(""), undefined);
  assert.equal(parseToolDisplayMode("custom"), undefined);
});

test("result mode detection compares only derived tool output modes", () => {
  const summary = applyToolDisplayMode(
    {
      ...DEFAULT_TOOL_DISPLAY_CONFIG,
      toolCallStyle: "claude",
      previewRows: 40,
      diffWordWrap: false,
    },
    "summary",
  );

  assert.equal(detectToolDisplayMode(summary), "summary");
  assert.equal(
    detectToolDisplayMode({ ...summary, readOutputMode: "preview" }),
    "custom",
  );
});

test("result mode configs are independent output-only patches", () => {
  const summary = getToolResultModeConfig("summary");
  const anotherSummary = getToolResultModeConfig("summary");

  assert.notEqual(summary, anotherSummary);
  assert.deepEqual(summary, anotherSummary);
  assert.deepEqual(Object.keys(summary).sort(), [
    "bashOutputMode",
    "mcpOutputMode",
    "readOutputMode",
    "searchOutputMode",
  ]);
});
