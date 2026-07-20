# @zhcsyncer/pi-extensions

## 0.4.0

### Minor Changes

- 3849eba: Integrate the bundle-private Search Hub tools with model-written display intents and shared result rendering. Custom tool providers can now set `outputMode: "inherit"` through the cooperative consumer API so their result display follows the global `results.mode` without requiring per-tool user configuration, and can provide structured call targets, metadata, result statuses, and duplicate-header offsets while retaining shared styling and preview budgets. Search Hub uses these hooks to display queries, shortened URLs, backend/reader details, counts, combine health, and truncation state instead of generic argument counts, and now documents `web_read.objective` consistently as a Jina CSS selector rather than a natural-language question.

## 0.3.0

### Minor Changes

- 04800e0: Replace the flat tool-display configuration with a strictly validated, grouped, sparse v2 format. Existing configs migrate atomically with a one-time backup and status-bar guidance for the removed `bashCollapsedLines` field. Tool results now use one `compact | summary | preview` mode and a shared wrapped-row `previewRows` budget across read, search, MCP, custom, and bash output, preventing extremely long single-line results from flooding the transcript. The bundled JSON Schema uses direct field names, debug reads the real user config, and thinking labels remain independently configurable.
- 88a9366: Publish a maintained fork of `@juicesharp/rpiv-todo` 1.20.0 as `@zhcsyncer/pi-todo` and include it in the aggregate bundle. Todo keeps branch-aware tool-result snapshots but hides successful transcript nodes in favor of its persistent widget, while preserving visible errors and intentionally avoiding display-intent metadata.

## 0.2.0

### Minor Changes

- c1bafff: Add the `pi-tool-display-intent` extension and include it in the root bundle. The new package combines compact tool rendering with model-written, RPC-visible intent phrases without an extra inference request, preserves deterministic TUI metadata, keeps intent examples in model context for reliable follow-up calls, provides deterministic fallbacks and an optional Claude Code-inspired TUI style, sanitizes outgoing display text, and provides a cooperative custom-tool wrapper. Its built-in intent configuration uses the focused `toolIntent.enabled`, `toolIntent.language`, and `toolIntent.maxLength` surface, with enabled intent always required and visible in TUI and legacy `displaySummary` config migrated on load. Model-written intent uses the theme's primary text color for stronger contrast, while deterministic fallback intent remains muted. Output profiles only update read/search/MCP/bash density and preserve style, intent, ownership, diff, and advanced preferences; the separate reset command restores complete defaults.

## 0.1.4

### Patch Changes

- 5709a8a: Use the editor widget as the sole persistent recap surface, remove the footer display mode and duplicate success notification, keep manual generation in its cancellable loader, and persistently clean up legacy display config fields.

## 0.1.3

## 0.1.2

### Patch Changes

- 24abac8: Improve the recap widget hierarchy, restore it after reload, and show a cancellable loading indicator while generating manual recaps.
