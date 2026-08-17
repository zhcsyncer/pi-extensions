---
"@zhcsyncer/pi-extensions": patch
"@zhcsyncer/pi-meter": patch
---

Idle TUI sessions pick up shared quota and local spend from disk on a slow timer, without calling subscription APIs.
