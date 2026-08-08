---
"@zhcsyncer/pi-subagents": minor
"@zhcsyncer/pi-extensions": minor
---

Upgrade the in-process subagent spawn contract to protocol v3 for orchestrator extensions. Callers can provide an inline role, own completion delivery, correlate lifecycle events, inspect requested/effective model and thinking, and discover the runtime concurrency limit. Ordinary Agent tools, named/project agents, fallback behavior, completion notifications, FleetView, and scheduling keep their existing behavior when the new fields are omitted.
