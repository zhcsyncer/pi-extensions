# Changelog

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
