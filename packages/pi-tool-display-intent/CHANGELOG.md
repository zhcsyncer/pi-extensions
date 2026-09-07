# Changelog

## 0.10.0

### Minor Changes

- 7b516df: Support clicking an entire Tools title row to expand or collapse one run in Pi 0.85+ fullscreen mode, while Ctrl+O continues to control the whole transcript. Expanded tool rows open a read-only Result/Args viewer with advanced Metadata, scrolling and structured parameter/metadata inspection. Long steers use bounded head/tail previews with a clickable omission row. Viewing never reruns a tool or changes Session messages.
- 7b516df: Add an opt-in Context growth setting to `/tools`. Aggregate receipts show `ctx` growth separately from token consumption, and expanded turn headers attribute reported input changes to the preceding turn. Unconfirmed turns and totals containing local estimates use `≈`; known context boundaries or missing data show an unavailable run total instead of a misleading sum. Only tool-bearing turns may show context footers; ordinary replies remain free of ledger chrome. Tool execution and Session messages are unchanged.
- 7b516df: Fold visible custom messages, including background task completion notices, into Run in their original transcript order. Preserve the original renderer and native interactions when expanded, keep hidden messages hidden, and show message-only segments without inventing tool calls. Notifications after a final answer start a new segment rather than being moved back to their dispatching run. Restore aggregation for history already rendered before extension reload completes.
- 7b516df: Keep the aggregate title in view when locally expanding a Tools run in compatible Pi fullscreen mode. When an expanded run's title scrolls out of view, show a fixed collapse control above the editor that closes only that run and returns to its title, without taking keyboard focus or using an overlay.
- 7b516df: Refine the read-only viewer with typed Args rows, multiline text blocks, JSON colors and conservative Markdown presentation. Keep only Result and Args as primary tabs, move Metadata behind the advanced entry, and provide a Raw switch while retaining terminal-control filtering and safety limits. Edit diffs appear directly in Result instead of a separate tab. Compact titles, right-aligned status and scroll positions, and notices only for actual transformations reduce visual clutter.
- 7b516df: Expand the clickable area to the whole collapsed Tools block and the expanded title/summary area, while preserving per-call detail inspection. Successful Edit calls with returned diff data show the diff directly in Result using the existing line-numbered renderer and the configured layout and wrapping. Raw return text and arguments remain accessible; failed edits and missing diff data show the ordinary result.
- 7b516df: Rename the aggregate Tools header to Run and aggregate Agent/consult by default, retaining explicitly configured passthrough exceptions. Generic call previews now show a couple identifying values without keys or payloads; Agent calls use compact task titles and distinguish background dispatch receipts from completed foreground work without modifying subagents. Fix collapse-widget layout feedback at the transcript bottom, including same-height streaming or timing updates, while preserving normal scrolling and focus.

### Patch Changes

- 7b516df: In aggregate layout, long bash rows show intent and size instead of the script body, and each call row right-aligns its duration (plus end time after it finishes).
- 7b516df: Keep the aggregate Tools ledger a bounded audit: custom tools show a deterministic target, image reads stay in the ledger, and long bash/tool-call rows wrap with a preview instead of dumping scripts or failing open.
- 7b516df: Aggregate Ctrl+O can group the timeline by agent turn. The default stays the flat per-call view; turn `/tools` Expanded timeline to `turns` without reloading.
- 7b516df: Keep expanded assistant narration at its established first-line inset, align continuation lines with the same marker-column spacing, and remove right-side padding that pushes short rows to the terminal edge. Reserve frame width before Markdown layout to preserve wrapped text without spurious truncation markers, while retaining intentional paragraph and code-block blank lines.
- 7b516df: Align explicit passthrough tools with the Run ledger's content inset while preserving their native renderer, expansion and interactions. Reserve the inset before layout and translate mouse coordinates so clicks, focus and drag capture still reach the original components.
- 7b516df: Aggregate keeps a blank line after the user prompt and passthrough tools; only the final reply under Tools omits it. Ctrl+O also leaves a framed gap before mid-turn narration. `/tools` now Tab-completes `aggregate` and `individual`.
- 7b516df: Only bash asks the model for intent. The intent.enabled switch is gone; language and maxLength stay. Search Hub no longer requires displaySummary.
- 7b516df: Show safe, bounded top-level argument previews for generic custom tools instead of only an argument count, while redacting credential-like fields and values.
- 7b516df: Automatically wrap long lines in the read-only detail viewer so tool results, parameters, metadata and steer messages can be read by vertical scrolling. Reflow on resize preserves the source text and keeps the reading position near the same content.
- 7b516df: Preserve credential values in the read-only inspector, render Markdown files as Markdown, and highlight Bash command arguments. Edit inspectors follow the global diff layout; Write stays single-column and explicitly shows written content as additions rather than an inferred overwrite delta. Both share the indicator and wrapping settings exposed in aggregate mode. Long Bash commands stay out of ledger parentheses unless the entire target fits one row, and ordinary replies no longer receive context-growth footers. Terminal-control filtering and bounded viewing remain in place.
- 7b516df: In aggregate layout, keep pre-tool narration as ordinary assistant text when the turn only has passthrough tools and no Tools ledger.
- 7b516df: In aggregate layout, keep pre-tool narration visible when that assistant message only has passthrough tools such as Consult, instead of hiding it until expand.
- 7b516df: Restore bounded multiline tool-call targets in aggregate ledgers after timing support made them single-line, and show failed-call details on indented continuation rows.
- 7b516df: Right-align the fixed Run collapse control and keep it first among above-editor widgets, without changing other widgets' relative order. Match the mouse hit area to the visible control so the empty left side remains non-interactive.
- 7b516df: Restore Run title anchoring and the fixed collapse control after reload when child sessions have used the extension. Bind shared renderer hooks to the UI host, release projections on all shutdown reasons, and hand off stale module dispatch without losing outer renderer wrappers or letting delayed cleanup disable the new session.
- 7b516df: Always use Claude-style tool chrome. Rename `/tool-display-intent` to `/tools`; empty args still open settings, and layout changes confirm then reload the session.
- 7b516df: Add Bash intent language to the `/tools` settings panel in both layouts, with explicit guidance that auto is best-effort and changes apply after `/reload`.
- 7b516df: Always show Write content in a single-column additions view, even when the global diff layout is split or automatic. Keep the configured indicators and wrapping, while Edit continues to follow the global diff layout.

## 0.9.0

### Minor Changes

- c7bf6cf: Keep mid-turn steers on the same aggregate Tools ledger. While the turn is running, pin each steer’s first line under the header; after it settles, leave one `↳ N steers` reminder under the title instead of repeating the count in parentheses. `Ctrl+O` restores each `↳` in place, highlighted, with framed gaps instead of opening a second book.

## 0.8.1

### Patch Changes

- 1768c9d: Keep the aggregate Tools ledger on the host session when Explore or another in-process session starts, and stop treating thinking as mid-turn narration or a final answer.
- 1768c9d: Render the in-progress aggregate Tools note as Markdown, keeping the three-line pin.
- 1768c9d: Keep a blank row between the aggregate user prompt and a direct final answer, and only drop it when a Tools ledger is already providing that gap.
- 1768c9d: Remove the Thinking label that rewrote stored reasoning text. Existing `transcript.thinkingLabel` settings are dropped.

## 0.8.0

### Minor Changes

- 4eff439: Add the optional `toolCalls.layout: "aggregate"` Tools view, with gallery and README screenshots of the collapsed, expanded, and failed ledgers. Every registered built-in, custom, MCP, and late-loaded tool now contributes to one branch-aware summary per user request. The collapsed header shows call and assistant-turn counts. While the turn is running, the latest assistant note stays pinned under the header, above the tool rows, without using a tool slot; after the turn settles, every assistant note hides and a muted receipt under the header shows duration, tokens, cache, and local completion time. Successful calls remain as replaceable `done` rows before a settled grace-period fold, collapsed failures stay count-only, and `Ctrl+O` restores the original timeline of notes plus one target/status summary per call. Aggregate always renders user prompts as a compact accent-gutter block with vertical padding and hides thinking labels; boxed-user and thinking-label settings stay retained but inactive. `Agent` keeps its original renderer by default, images fail open, collapsed `Thinking...` placeholders are stripped, no file-change statistics are inferred or persisted, and switching back to `individual` restores the original renderers over unchanged raw session calls/results.

## 0.7.1

### Patch Changes

- 44c7eee: Declare and verify compatibility with Pi 0.84 across the bundled extensions.

## 0.7.0

### Minor Changes

- 13df227: Add `diff.collapsedMode` to `pi-tool-display-intent`. When set to `summary`, edit and write diffs collapse to a single `↳ diff +N -M • H hunks • F files` stats line (plus a `Ctrl+O to expand` hint) before expansion, instead of the first `diff.collapsedRows` rows. The default `body` keeps the existing preview. The setting is exposed in the `/tool-display-intent` inspector as "Diff collapsed style" and rounds-trips through the v2 config; invalid values fall back to `body`.

## 0.6.1

### Patch Changes

- c75a5d8: Keep path-bearing built-in tool call headers compact at narrow widths. Collapsed `read`, `grep`, `find`, `ls`, `edit`, and `write` calls now abbreviate middle path segments while preserving useful anchors and the basename; expanding tools with `Ctrl+O` restores the complete path.
- c75a5d8: Improve Bash transcript readability in Claude-style rendering. Separate command previews now emphasize their shell prompt, expanded commands use bounded Bash syntax highlighting, and Bash result gutters connect through the final row in collapsed and expanded views. The shared `results.previewRows` setting now exposes and enforces a minimum of two rows.
- c75a5d8: Restore built-in `promptSnippet` and `promptGuidelines` when overriding tools for display. Overrides now read metadata from Pi ToolDefinitions instead of wrapped AgentTools, so `read`, `write`, and the other owned tools reappear in the system prompt `Available tools` section.
- c75a5d8: Keep generic and MCP failures visible in every result mode. Failed tools now render one content-derived error summary even when compact mode hides successful output, while `Ctrl+O` reveals the complete error content through the existing expanded preview budget.

## 0.6.0

### Minor Changes

- 1683e4f: Unify bundle extension configuration and state under `$PI_CODING_AGENT_DIR/extension-data/<extension-id>/`. Existing global and trusted-project files are migrated and upgraded automatically, unmappable fields are discarded with user-visible warnings, malformed files are preserved, and Plan artifacts remain at `$PI_CODING_AGENT_DIR/plans/`. Search Hub now reads refreshed configuration through Jiti-safe accessors so reader selection, credentials, and round-robin state take effect immediately.

## 0.5.1

### Patch Changes

- 9165916: Reduce prompt overhead for model-written tool intents. Wrapped tools now share one Pi-deduplicatable guideline, preserve their original descriptions, and retain detailed `displaySummary` field guidance in each schema. This trims the initial bundle prompt without changing execution, RPC, fallback, or rendering semantics.

## 0.5.0

### Minor Changes

- c1b1172: Collapse long and multiline Bash call arguments into a width-aware preview with line and size metadata, while letting Ctrl+O reveal the complete original command. Add `toolCalls.bashCommandPreviewRows` to control the collapsed command budget and keep Claude-style intents in an intent-first header.

  Emphasize model-written tool intents with the theme accent color while rendering deterministic commands, paths, and queries as normal text and retaining muted fallback intents.

## 0.4.0

### Minor Changes

- 3849eba: Integrate the bundle-private Search Hub tools with model-written display intents and shared result rendering. Custom tool providers can now set `outputMode: "inherit"` through the cooperative consumer API so their result display follows the global `results.mode` without requiring per-tool user configuration, and can provide structured call targets, metadata, result statuses, and duplicate-header offsets while retaining shared styling and preview budgets. Search Hub uses these hooks to display queries, shortened URLs, backend/reader details, counts, combine health, and truncation state instead of generic argument counts, and now documents `web_read.objective` consistently as a Jina CSS selector rather than a natural-language question.

## 0.3.0

### Minor Changes

- 04800e0: Replace the flat tool-display configuration with a strictly validated, grouped, sparse v2 format. Existing configs migrate atomically with a one-time backup and status-bar guidance for the removed `bashCollapsedLines` field. Tool results now use one `compact | summary | preview` mode and a shared wrapped-row `previewRows` budget across read, search, MCP, custom, and bash output, preventing extremely long single-line results from flooding the transcript. The bundled JSON Schema uses direct field names, debug reads the real user config, and thinking labels remain independently configurable.

## 0.2.0

### Minor Changes

- c1bafff: Add the `pi-tool-display-intent` extension and include it in the root bundle. The new package combines compact tool rendering with model-written, RPC-visible intent phrases without an extra inference request, preserves deterministic TUI metadata, keeps intent examples in model context for reliable follow-up calls, provides deterministic fallbacks and an optional Claude Code-inspired TUI style, sanitizes outgoing display text, and provides a cooperative custom-tool wrapper. Its built-in intent configuration uses the focused `toolIntent.enabled`, `toolIntent.language`, and `toolIntent.maxLength` surface, with enabled intent always required and visible in TUI and legacy `displaySummary` config migrated on load. Model-written intent uses the theme's primary text color for stronger contrast, while deterministic fallback intent remains muted. Output profiles only update read/search/MCP/bash density and preserve style, intent, ownership, diff, and advanced preferences; the separate reset command restores complete defaults.

All notable changes to `@zhcsyncer/pi-tool-display-intent` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Forked `pi-tool-display` 0.5.0 into the `@zhcsyncer/pi-extensions` workspace under an independent package, config path, command, and runtime API namespace.
- Added model-written `displaySummary` intent fields for seven owned built-in tools without additional inference requests.
- Added sanitized TUI intent suffixes while retaining deterministic paths, commands, search patterns, and diff metadata.
- Added deterministic per-tool intent fallbacks and optional Claude Code-inspired tool-call framing.
- Added a cooperative `withDisplaySummary()` API for custom tool providers.
- Added English and Chinese documentation, upstream attribution, and preserved upstream license/history files.

### Changed

- Replaced the flat configuration with a grouped, sparse v2 format that is strictly validated, atomically migrated with a one-time legacy backup, and documented by a bundled JSON Schema.
- Replaced result Profiles and per-tool overrides with `results.mode: compact | summary | preview` plus one shared `results.previewRows` budget for read, search, MCP, custom, and bash previews.
- Simplified built-in intent configuration to `toolIntent.enabled`, `toolIntent.language`, and `toolIntent.maxLength`; enabled intent is now always schema-required and visible in TUI, while legacy `displaySummary` config is migrated on load.
- Increased intent contrast by rendering model-written phrases with the theme's primary text color and deterministic fallbacks with the muted color.
- Renamed public fields for direct meaning (`toolCalls.style`, `diff.collapsedRows`, `transcript.userMessageStyle`, `tools.passthrough`, and `advanced.expandedRows`) and removed redundant extension/custom enable switches.
- Kept legacy result mode and preset command names as aliases; `bashCollapsedLines` is discarded during migration with a one-time Pi status-bar adjustment hint.

### Fixed

- Prevented minified JSON, base64, and other very long single-line tool results from bypassing collapsed and expanded preview budgets across read, search, MCP, custom, and bash renderers.
- Retained recent intent fields in model context so resumed and multi-turn runs continue producing `displaySummary`.
- Backfilled missing intent into raw arguments before validation so later TUI/RPC updates can observe the fallback.
- Canonicalized workspace preview containment checks without rejecting macOS `/var` paths that resolve under `/private/var`.
