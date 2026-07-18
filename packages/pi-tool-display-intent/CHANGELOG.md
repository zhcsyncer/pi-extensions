# Changelog

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

- Simplified built-in intent configuration to `toolIntent.enabled`, `toolIntent.language`, and `toolIntent.maxLength`; enabled intent is now always schema-required and visible in TUI, while legacy `displaySummary` config is migrated on load.
- Increased intent contrast by rendering model-written phrases with the theme's primary text color and deterministic fallbacks with the muted color.
- Decoupled output profiles from tool-call style, intent, ownership, diff, and advanced settings; applying a preset now updates only read/search/MCP/bash output density, while `reset` restores the complete defaults.

### Fixed

- Retained recent intent fields in model context so resumed and multi-turn runs continue producing `displaySummary`.
- Backfilled missing intent into raw arguments before validation so later TUI/RPC updates can observe the fallback.
- Canonicalized workspace preview containment checks without rejecting macOS `/var` paths that resolve under `/private/var`.
