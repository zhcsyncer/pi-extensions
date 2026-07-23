---
"@zhcsyncer/pi-extensions": patch
"@zhcsyncer/pi-tool-display-intent": patch
---

Reduce prompt overhead for model-written tool intents. Wrapped tools now share one Pi-deduplicatable guideline, preserve their original descriptions, and retain detailed `displaySummary` field guidance in each schema. This trims the initial bundle prompt without changing execution, RPC, fallback, or rendering semantics.
