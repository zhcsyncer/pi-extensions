---
"@zhcsyncer/pi-extensions": minor
"@zhcsyncer/pi-tool-display-intent": minor
---

Replace the flat tool-display configuration with a strictly validated, grouped, sparse v2 format. Existing configs migrate atomically with a one-time backup and status-bar guidance for the removed `bashCollapsedLines` field. Tool results now use one `compact | summary | preview` mode and a shared wrapped-row `previewRows` budget across read, search, MCP, custom, and bash output, preventing extremely long single-line results from flooding the transcript. The bundled JSON Schema uses direct field names, debug reads the real user config, and thinking labels remain independently configurable.
