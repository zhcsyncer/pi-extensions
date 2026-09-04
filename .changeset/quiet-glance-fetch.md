---
"@zhcsyncer/pi-extensions": patch
"@zhcsyncer/pi-glance": patch
---

Prevent Glance's background `origin/main` fetch from opening interactive Git, SSH host-key, or credential prompts that can corrupt fullscreen terminal input.
