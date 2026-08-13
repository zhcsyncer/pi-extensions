---
"@zhcsyncer/pi-extensions": patch
"@zhcsyncer/pi-subagents": patch
---

Deliver manually launched background Agent completions as `steer` messages so current-task results reach the parent before its next model call instead of starving behind a long tool loop. Scheduled and cross-extension RPC completions retain detached `followUp` delivery, foreground results remain inline, and the Agent contract now requires foreground for prerequisite results plus genuinely disjoint background work without repeating delegated evidence collection.
