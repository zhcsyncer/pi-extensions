---
"@zhcsyncer/pi-extensions": minor
"@zhcsyncer/pi-tool-display-intent": minor
---

Fold visible custom messages, including background task completion notices, into Run in their original transcript order. Preserve the original renderer and native interactions when expanded, keep hidden messages hidden, and show message-only segments without inventing tool calls. Notifications after a final answer start a new segment rather than being moved back to their dispatching run. Restore aggregation for history already rendered before extension reload completes.
