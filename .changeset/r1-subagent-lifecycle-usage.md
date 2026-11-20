---
"@zhcsyncer/pi-subagents": patch
"@zhcsyncer/pi-extensions": patch
---

Adapt subagent execution to Pi 1.1: distinguish extension-handled steering from queued input, report cancellation without assuming a turn-limit cause, wait for actual cancellation and delivery settlement before releasing execution resources, restore valid retain-none compaction history, and preserve turn-limit guidance. Reconcile recorded child usage by stable session-entry identity and report parent usage exactly once per selected branch, including outer tool results and explicit usage/summary costs without nested double-counting. This runtime path requires Pi 1.1 or later; it does not enable MCP or codemode.
