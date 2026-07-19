---
"@zhcsyncer/pi-extensions": minor
"@zhcsyncer/pi-tool-display-intent": minor
---

Replace the flat tool-display configuration with a grouped, sparse v2 format. Existing configs are migrated atomically on load with a one-time legacy backup, result profiles now persist as `minimal`, `balanced`, or `detailed` baselines with per-tool overrides, and a bundled JSON Schema supports direct editing. Preview budgets are now named `previewRows` and `collapsedRows` and count wrapped terminal rows, preventing extremely long single-line read, search, MCP, custom, and bash output from flooding the transcript. Debug logging now reads the real user config, and thinking labels can be toggled under transcript settings.
