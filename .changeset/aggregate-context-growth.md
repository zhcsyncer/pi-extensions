---
"@zhcsyncer/pi-tool-display-intent": minor
---

Add an opt-in Context growth setting to `/tools`. Aggregate receipts show `ctx` growth separately from token consumption, and expanded turn headers attribute reported input changes to the preceding turn. Unconfirmed turns and totals containing local estimates use `≈`; known context boundaries or missing data show an unavailable run total instead of a misleading sum. Only tool-bearing turns may show context footers; ordinary replies remain free of ledger chrome. Tool execution and Session messages are unchanged.
