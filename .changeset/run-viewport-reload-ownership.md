---
"@zhcsyncer/pi-tool-display-intent": patch
---

Restore Run title anchoring and the fixed collapse control after reload when child sessions have used the extension. Bind shared renderer hooks to the UI host, release projections on all shutdown reasons, and hand off stale module dispatch without losing outer renderer wrappers or letting delayed cleanup disable the new session.
