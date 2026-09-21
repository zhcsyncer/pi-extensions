# @zhcsyncer/pi-search-hub

## 1.0.0

### Major Changes

- 1192e34: Search Hub keeps Exa, Tavily, Firecrawl, and Parallel, and adds OpenAI Codex and Grok search through Pi `/login` hosted web search (defaults: `gpt-5.6-luna`, `grok-4.3`). After a hosted backend hits a subscription usage limit, Search Hub skips it for 5 hours. Tavily and Firecrawl keys cache remaining quota locally; exhausted keys are skipped until the next billing cycle. Exa and Parallel keys that hit quota are skipped for 24 hours. `/search-hub status` shows this ledger. Configure with `/search-hub setup`. `web_search` no longer accepts `backend`; combine is model-only and off by default. `web_read` no longer accepts `reader`. Old backend names are no longer valid, and Firecrawl remains the keyless search fallback.

### Patch Changes

- 1192e34: Search Hub draws its own Claude-style tool rows and no longer needs pi-tool-display-intent.

## 0.1.2

### Patch Changes

- f3b8c32: Warn when a Search Hub backend or reader starts failing repeatedly. Local call outcomes are stored only for that check and are not used as remaining quota.

## 0.1.1

### Patch Changes

- 7b516df: Only bash asks the model for intent. The intent.enabled switch is gone; language and maxLength stay. Search Hub no longer requires displaySummary.
- 7b516df: Route Search Hub credential, configuration and Exa usage warnings through deduplicated Pi notifications instead of raw terminal output. Retain diagnostics in successful tool-result details, including headless runs, without changing provider fallback behavior. Strip terminal controls and redact common credential formats before displaying diagnostics, and avoid exposing failed credential shell commands.
