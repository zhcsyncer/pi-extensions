import assert from "node:assert/strict";
import test from "node:test";
import {
  applyToolDisplayPreset,
  detectToolDisplayPreset,
  getToolOutputPresetConfig,
  parseToolDisplayPreset,
} from "../src/presets.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

test("preset parsing is case-insensitive and rejects unknown names", () => {
  assert.equal(parseToolDisplayPreset(" BALANCED "), "balanced");
  assert.equal(parseToolDisplayPreset("Verbose"), "verbose");
  assert.equal(parseToolDisplayPreset(""), undefined);
  assert.equal(parseToolDisplayPreset("custom"), undefined);
});

test("preset detection only compares output-profile fields", () => {
  const balanced = applyToolDisplayPreset(
    {
      ...DEFAULT_TOOL_DISPLAY_CONFIG,
      toolCallStyle: "claude",
      toolIntent: { enabled: false, language: "zh-CN", maxLength: 64 },
      registerToolOverrides: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
        read: false,
      },
      diffViewMode: "split",
    },
    "balanced",
  );

  assert.equal(detectToolDisplayPreset(balanced), "balanced");
  assert.equal(
    detectToolDisplayPreset({ ...balanced, previewLines: balanced.previewLines + 1 }),
    "custom",
  );
});

test("preset configs are independent output-only patches", () => {
  const balanced = getToolOutputPresetConfig("balanced");
  const anotherBalanced = getToolOutputPresetConfig("balanced");

  assert.notEqual(balanced, anotherBalanced);
  assert.deepEqual(balanced, anotherBalanced);
  assert.deepEqual(Object.keys(balanced).sort(), [
    "bashCollapsedLines",
    "bashOutputMode",
    "mcpOutputMode",
    "previewLines",
    "readOutputMode",
    "searchOutputMode",
  ]);
});
