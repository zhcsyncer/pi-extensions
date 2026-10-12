---
"@zhcsyncer/pi-fast-mode": patch
"@zhcsyncer/pi-extensions": patch
---

Align Fast Mode with Pi 1.1: preserve request options and provider stream hooks, let the official Responses adapter apply model/thinking/request sampling precedence, and use the SDK's context-safe output budget. Fast still changes only same-model service priority, without switching accounts or billing channels. Requires Pi 1.1 or later.
