---
"@zhcsyncer/pi-todo": patch
"@zhcsyncer/pi-extensions": patch
---

Stop injecting live Todo state into the model prompt. No-op updates now return "No changes; state already matches" without writing a checkpoint.
