---
"pi-provider-cursor-ask": patch
---

Billing display and diagnostics for turns whose Cursor billing receipt never arrives. Missing receipts are now filled with a local estimate — marked `billing.status: "estimated"` in message metadata — computed from the live context snapshot, accumulated output deltas, and the conversation's previous-context anchor, priced at the model's configured rates. `usage.totalTokens` still carries the context observation and compaction behavior is unchanged. Billing incompleteness no longer writes warnings into the chat transcript: unconsumed receipts show a short footer status, and a normal tool-pause transport close no longer surfaces any warning.
