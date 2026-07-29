---
"@zhcsyncer/pi-extensions": patch
"@zhcsyncer/pi-tool-display-intent": patch
---

Improve Bash transcript readability in Claude-style rendering. Separate command previews now emphasize their shell prompt, expanded commands use bounded Bash syntax highlighting, and Bash result gutters connect through the final row in collapsed and expanded views. The shared `results.previewRows` setting now exposes and enforces a minimum of two rows.
