# Changelog

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

### Fixed

- Retained recent intent fields in model context so resumed and multi-turn runs continue producing `displaySummary`.
- Backfilled missing intent into raw arguments before validation so later TUI/RPC updates can observe the fallback.
- Canonicalized workspace preview containment checks without rejecting macOS `/var` paths that resolve under `/private/var`.
