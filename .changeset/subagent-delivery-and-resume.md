---
"@zhcsyncer/pi-subagents": patch
"@zhcsyncer/pi-extensions": patch
---

Improve subagent result delivery and continuation. Background notifications carry final reports within a shared 16 KiB UTF-8 message budget, explicitly marking truncation with a full-result retrieval path. Steering completed or soft-limit agents continues the same context in the background; explicit resume supports foreground and background execution with normal concurrency, waiting, and cancellation semantics. Eligible persisted terminal sessions can recover with their original execution configuration; missing recovery prerequisites fail explicitly instead of starting fresh. Failed or stopped continuations retain the previous completed report, clearly labeled as historical rather than the current result, even when the child conversation file cannot be opened. Failed or stopped agents still require explicit retry, and interrupted in-flight work is not replayed after a crash. Fence stale completions across resumed runs and clarify these contracts in streamlined bilingual documentation.
