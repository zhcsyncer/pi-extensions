---
"@zhcsyncer/pi-extensions": major
"@zhcsyncer/pi-search-hub": major
---

Search Hub keeps Exa, Tavily, Firecrawl, and Parallel, and adds OpenAI Codex and Grok search through Pi `/login` hosted web search (defaults: `gpt-5.6-luna`, `grok-4.3`). After a hosted backend hits a subscription usage limit, Search Hub skips it for 5 hours. Tavily and Firecrawl keys cache remaining quota locally; exhausted keys are skipped until the next billing cycle. Exa and Parallel keys that hit quota are skipped for 24 hours. `/search-hub status` shows this ledger. Configure with `/search-hub setup`. `web_search` no longer accepts `backend`; combine is model-only and off by default. `web_read` no longer accepts `reader`. Old backend names are no longer valid, and Firecrawl remains the keyless search fallback.
