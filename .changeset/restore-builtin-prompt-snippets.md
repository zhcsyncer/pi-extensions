---
"@zhcsyncer/pi-extensions": patch
"@zhcsyncer/pi-tool-display-intent": patch
---

Restore built-in `promptSnippet` and `promptGuidelines` when overriding tools for display. Overrides now read metadata from Pi ToolDefinitions instead of wrapped AgentTools, so `read`, `write`, and the other owned tools reappear in the system prompt `Available tools` section.
