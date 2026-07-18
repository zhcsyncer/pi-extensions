---
"@zhcsyncer/pi-extensions": minor
"@zhcsyncer/pi-tool-display-intent": minor
---

Add the `pi-tool-display-intent` extension and include it in the root bundle. The new package combines compact tool rendering with model-written, RPC-visible intent phrases without an extra inference request, preserves deterministic TUI metadata, keeps intent examples in model context for reliable follow-up calls, provides deterministic fallbacks and an optional Claude Code-inspired TUI style, sanitizes outgoing display text, and provides a cooperative custom-tool wrapper. Its built-in intent configuration uses the focused `toolIntent.enabled`, `toolIntent.language`, and `toolIntent.maxLength` surface, with enabled intent always required and visible in TUI and legacy `displaySummary` config migrated on load. Model-written intent uses the theme's primary text color for stronger contrast, while deterministic fallback intent remains muted. Output profiles only update read/search/MCP/bash density and preserve style, intent, ownership, diff, and advanced preferences; the separate reset command restores complete defaults.
