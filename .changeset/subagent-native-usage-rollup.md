---
"@zhcsyncer/pi-subagents": patch
"@zhcsyncer/pi-meter": patch
"@zhcsyncer/pi-extensions": patch
---

Show collected subagent tokens and cost in Pi native session statistics and Glance by default. Foreground Agent results and completed background result retrievals report each agent's unreported lifetime spend once, including resumed sessions. Keep pinned pi-meter observers recording child messages, while excluding duplicate parent usage rollups from live capture and history imports. Native rollups require Pi 0.81.0 or newer and can be disabled with reportUsage.
