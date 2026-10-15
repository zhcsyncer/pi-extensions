---
"@zhcsyncer/pi-subagents": patch
"@zhcsyncer/pi-extensions": patch
---

Allow Agent, get_subagent_result, and steer_subagent to be called directly or through optional codemode orchestration on Pi 1.2+. Resume current-version tasks using current named or inline role permissions rather than a historical permission ceiling, while preserving the original task context, explicit isolation, and direct/nested tool authorization gates. Live continuation reports when newly required extensions need a fresh session; saved tasks load current resources on recovery. Preserve managed foreground/background lifecycles and carry nested usage receipts with the SDK's parent result so retrieval and restart do not double-count child usage. Codemode and MCP are not enabled automatically, and child agents still cannot recursively invoke the orchestration tools.
