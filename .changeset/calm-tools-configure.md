---
"@zhcsyncer/pi-extensions": minor
"@zhcsyncer/pi-tool-display-intent": minor
---

Replace the flat tool-display configuration with a grouped, sparse v2 format. Existing configs are migrated atomically on load with a one-time legacy backup, result profiles now persist as `minimal`, `balanced`, or `detailed` baselines with per-tool overrides, and a bundled JSON Schema supports direct editing. Debug logging now reads the real user config, and thinking labels can be toggled under transcript settings.
