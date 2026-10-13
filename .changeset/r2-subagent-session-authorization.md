---
"@zhcsyncer/pi-subagents": patch
"@zhcsyncer/pi-extensions": patch
---

Enforce subagent tool/source permissions for direct, nested, and late-registered calls without treating tool visibility as authorization. Keep role presentation, tool schemas, pins, and execution settings bound to their owning runtime, and limit resumed sessions to historical permissions intersected with current trusted authorization. Saved reports remain readable when authorization cannot be verified. Mark Agent/get/steer as model-only without changing parallel scheduling or enabling MCP/codemode.
