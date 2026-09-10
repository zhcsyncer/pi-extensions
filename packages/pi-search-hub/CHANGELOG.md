# @zhcsyncer/pi-search-hub

## 0.1.2

### Patch Changes

- f3b8c32: Warn when a Search Hub backend or reader starts failing repeatedly. Local call outcomes are stored only for that check and are not used as remaining quota.

## 0.1.1

### Patch Changes

- 7b516df: Only bash asks the model for intent. The intent.enabled switch is gone; language and maxLength stay. Search Hub no longer requires displaySummary.
- 7b516df: Route Search Hub credential, configuration and Exa usage warnings through deduplicated Pi notifications instead of raw terminal output. Retain diagnostics in successful tool-result details, including headless runs, without changing provider fallback behavior. Strip terminal controls and redact common credential formats before displaying diagnostics, and avoid exposing failed credential shell commands.
