---
"@zhcsyncer/pi-extensions": minor
"@zhcsyncer/pi-subagents": minor
---

Persist ordinary subagents as parent-linked Pi sessions by default so `/resume` can open their complete conversations, and add a finished-agent history in `/agents` that reopens retained or disk-only runs in the existing brief overlay. Add `rememberAgents` for restoring memory-only defaults. Port the `isolation: "off" | "worktree"` shape with `off` first, and add a repository `worktreeIsolation` capability switch that defaults off in this fork: disabled repositories remove the Agent schema/prose and downgrade tool, agent-file, scheduler, and RPC worktree requests to the real checkout, while enabled worktree creation remains strict.
