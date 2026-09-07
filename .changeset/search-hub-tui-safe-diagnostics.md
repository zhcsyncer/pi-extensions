---
"@zhcsyncer/pi-extensions": patch
"@zhcsyncer/pi-search-hub": patch
---

Route Search Hub credential, configuration and Exa usage warnings through deduplicated Pi notifications instead of raw terminal output. Retain diagnostics in successful tool-result details, including headless runs, without changing provider fallback behavior. Strip terminal controls and redact common credential formats before displaying diagnostics, and avoid exposing failed credential shell commands.
