# Codemode Tool Display and Nested Calls

## Overview

Pi's built-in `codemode` tool runs JavaScript scripts in a QuickJS WASI sandbox to orchestrate other tools via `ctx.executeTool()`.

In Pi's transcript data model, nested tool calls emitted during a script execution:
1. Emit `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` events with `parentToolCallId`.
2. Do **not** create separate transcript entries (`ToolCall` / `ToolResultMessage`) in session message history.
3. Are persisted as bounded `nestedCalls` on the parent `codemode` tool result message.

`pi-tool-display-intent` integrates with `codemode` across both display layouts.

## Aggregate Layout

In `aggregate` layout:
- **Consistent Call Count**: The Run header counts top-level transcript tool calls (keeping live runs and reloads identical).
- **Hierarchical Live Active State**: When `tool_execution_start` with `parentToolCallId` fires, the live row reflects what `codemode` is actively executing:
  ```text
  ◐ Codemode(Count files) › Read(package.json)
  ```
- **Nested Summary on Completion**: When `codemode` completes or history is rebuilt from transcript, nested call counts are summarized:
  ```text
  ✓ Codemode(Count files) (read ×2 · bash ×1)
  ```
- **Rebuild Fidelity**: `ingestToolResult` restores `result.nestedCalls`, so `/reload`, `/tree`, and compaction retain full visibility of nested activity.

## Individual Layout

In `individual` layout:
- **Call Rendering (`renderCall`)**:
  - Displays tool badge, intent/displaySummary, and a formatted code snippet preview.
  - Automatically strips leading `// @options: ...` config lines from the preview.
  - Supports both `compact` and `claude` tool call styles.
- **Result Rendering (`renderResult`)**:
  - Displays script completion status and execution time.
  - Formats nested tool calls as structured status badges (`✓ read ×2 · ✓ bash ×1`).
  - In expanded view (`Ctrl+O`), shows each nested tool call with duration and arguments.
- **Intent Schema**:
  - Decorates `codemode` with `displaySummary` in parameters and prompt guidelines.
  - Falls back gracefully to leading code comments (`// <intent>` or `/* <intent> */`) or deterministic fallbacks (`"Run script"` / `"运行脚本"`).

## Detail Viewer

When clicking on a `codemode` row:
- **Args Tab**: Highlights script `code` with TypeScript syntax highlighting.
- **Result Tab**: Displays script stdout/error alongside a structured, readable list of all nested tool calls.
