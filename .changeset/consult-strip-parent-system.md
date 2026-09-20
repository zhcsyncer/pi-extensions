---
"@zhcsyncer/pi-consult": patch
---

Strip parent system/tool transcript entries before advisor calls so `tools: []` cannot leak executor tools on Pi 0.86.
