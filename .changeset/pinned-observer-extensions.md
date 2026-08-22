---
"@zhcsyncer/pi-extensions": minor
"@zhcsyncer/pi-subagents": minor
---

Add `pinnedExtensions` so trusted observer extensions (such as pi-meter) stay loaded in every subagent session, including isolated runs, without exposing their tools. Only the user-owned global config may grant observer names; project config can use `[]` to opt out, while non-empty project pins are ignored with a warning so checked-in repositories cannot authorize their own handlers.
