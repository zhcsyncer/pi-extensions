---
"@zhcsyncer/pi-tool-display-intent": patch
"@zhcsyncer/pi-extensions": patch
---

Use Pi 1.1 public tool renderers for built-in, custom, late-connected MCP, and historical tool calls while preserving specialized content and renderer state. Keep Bash argument preparation, structured results, cancellation and execution context intact, preserve Write's pre-write comparison, and avoid changing tool availability or enabling codemode. Reload cleanup no longer removes a newer display owner's decorations.
