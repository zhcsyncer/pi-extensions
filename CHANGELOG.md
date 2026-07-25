# @zhcsyncer/pi-extensions

## 0.8.0

### Minor Changes

- da42f35: Turn `/search-setup` into Search Hub's combined status and configuration dashboard, remove the separate `/search-status` command and footer activity, add ordered default-reader fallback, simplify search routing into fallback/targeted/all modes, and remove the unused local search-result cache and cache settings. Backend rows now expose switch, unified resolved-auth readiness, URL, and project-override status up front; unresolved references display as no credential. Detail menus separate credential management from enablement and show global versus effective state, while Codex search resolves its credential through the current Pi model registry. Backends now live on a dedicated second-level page. All setup pages share one in-memory draft, and `Save & apply` validates and atomically writes once; closing with dirty state offers save, discard, or continued editing. Backend disablement remains reversible, and blank required credentials cannot enable a backend.
- da42f35: Add automatic nearest-layer terminal multiplexer naming to recap: Herdr pane labels now take precedence over inherited tmux windows, legacy `tmux` config migrates to `multiplexer`, and ownership-aware restore avoids clobbering later manual renames while handling disable, reload, and shutdown lifecycles.
- da42f35: Make Todo reliable for multi-stage work: isolate state per SDK session runtime, enforce lifecycle and dependency contracts, add atomic batch mutations, report validation failures as tool errors, and expose hidden successful calls in expanded audit views. Single-step work is now explicitly excluded from Todo guidance.

## 0.7.0

### Minor Changes

- f3d7b88: Add a temporary read-only Plan Mode with `/plan on|off`, the `--plan` startup flag, keyboard shortcuts, fail-closed tools, revdiff review with word-level revision comparisons, immutable Plan revisions, configurable English or Simplified Chinese Plan content, compact custom-message approval handoff, immediate normal-tool restoration, and collapsible display-only Steps widgets.

## 0.6.0

### Minor Changes

- 801204d: Add the maintained `@zhcsyncer/pi-glance` fork with composable extension statuses, configurable standalone or input-border context progress, one-third or remaining-width layouts, shared 70/85 context risk colors, and a plain/Nerd Font auto-compaction marker with semantic highlighting.

## 0.5.1

### Patch Changes

- 9165916: Reduce prompt overhead for model-written tool intents. Wrapped tools now share one Pi-deduplicatable guideline, preserve their original descriptions, and retain detailed `displaySummary` field guidance in each schema. This trims the initial bundle prompt without changing execution, RPC, fallback, or rendering semantics.

## 0.5.0

### Minor Changes

- c1b1172: Collapse long and multiline Bash call arguments into a width-aware preview with line and size metadata, while letting Ctrl+O reveal the complete original command. Add `toolCalls.bashCommandPreviewRows` to control the collapsed command budget and keep Claude-style intents in an intent-first header.

  Emphasize model-written tool intents with the theme accent color while rendering deterministic commands, paths, and queries as normal text and retaining muted fallback intents.

### Patch Changes

- c1b1172: Add structurally aligned English and Simplified Chinese documentation for the root bundle and its private Search Hub fork. Document Search Hub's intent-aware semantic call lines, backend and reader result status, inherited display modes, shared preview budget, and Jina CSS selector semantics, and verify both README variants in npm pack checks.
- 7a843b3: Remove release-version pins from every maintained README installation command so users always install the current repository release without documentation churn. Remove the version-time README rewrite and add a pack check that prevents pinned installation examples from returning.

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
