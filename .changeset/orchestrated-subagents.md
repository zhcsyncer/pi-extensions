---
"@zhcsyncer/pi-subagents": minor
"@zhcsyncer/pi-extensions": minor
---

Upgrade the in-process subagent spawn contract to protocol v3 for orchestrator extensions. Callers can provide an inline role, own completion delivery, correlate lifecycle events, inspect requested/effective model and thinking, discover the runtime concurrency limit, and optionally set per-spawn `graceTurns` after the soft max-turn steer. A side-effect-free `@zhcsyncer/pi-subagents/runtime` entry now exposes the same AgentManager/runAgent execution core to dependent packages without registering Agent tools, commands, scheduling, widgets, or FleetView. Ordinary Agent tools, named/project agents, fallback behavior, completion notifications, FleetView, scheduling, and the global five-turn grace default keep their existing behavior when the new fields are omitted.
