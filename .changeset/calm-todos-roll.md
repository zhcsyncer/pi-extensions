---
"@zhcsyncer/pi-todo": minor
"@zhcsyncer/pi-extensions": minor
---

Bound Todo to the current execution cycle: use mutation-only V2 replay checkpoints, automatically roll terminal cycles forward without reusing IDs, keep default lists focused on active work, and inject a compact active-state summary into each agent run.

Move destructive reset out of the model tool and into the confirmed `/todo` TUI flow, with active-work warnings, branch-scoped persistence, legacy V1 replay compatibility, and immediate widget refresh.

Reject singleton Todo cycles at runtime: an empty or terminal cycle must start with an atomic multi-item batch. Risk, duration, or importance cannot justify a one-task plan; one-milestone work runs directly without filler tasks.

Remove dependency-graph fields, validation, deletion guards, and UI from the current Todo contract. Todo is now an ordered serial execution focus for surviving context growth and compaction; legacy checkpoints remain replay-compatible while retired dependency data is discarded.
