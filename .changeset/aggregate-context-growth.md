---
"@zhcsyncer/pi-tool-display-intent": minor
---

Add an opt-in Context growth setting to `/tools`. Aggregate receipts show `ctx` growth separately from token consumption, and expanded turn headers attribute reported input changes to the preceding turn. Unconfirmed turns and totals containing local estimates use `≈`; known context boundaries or missing data show an unavailable run total instead of a misleading sum. Final text and passthrough-only turns can show lightweight context footers without changing tool execution or Session messages.
