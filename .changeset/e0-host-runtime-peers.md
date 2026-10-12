---
"@zhcsyncer/pi-extensions": patch
"@zhcsyncer/pi-adversarial-review": patch
"@zhcsyncer/pi-ask-user-question": patch
"@zhcsyncer/pi-consult": patch
"@zhcsyncer/pi-context7": patch
"@zhcsyncer/pi-fast-mode": patch
"@zhcsyncer/pi-glance": patch
"@zhcsyncer/pi-herdr-companion": patch
"@zhcsyncer/pi-meter": patch
"@zhcsyncer/pi-plan-mode": patch
"@zhcsyncer/pi-search-hub": patch
"@zhcsyncer/pi-subagents": patch
"@zhcsyncer/pi-todo": patch
"@zhcsyncer/pi-tool-display-intent": patch
"pi-provider-cursor-ask": patch
"pi-provider-volcengine-agent-plan": patch
---

Declare Pi-provided SDK and TypeBox modules as unconstrained host peers instead of bundled runtime dependencies or restrictive host dependency ranges. Development checks now use the verified Pi 1.1.0 SDK graph; installing the package does not enable codemode or MCP.
