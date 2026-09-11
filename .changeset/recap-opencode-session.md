---
"@zhcsyncer/pi-recap": patch
"@zhcsyncer/pi-extensions": patch
---

Recap no longer fails with 400 on OpenCode / OpenCode Go due to a missing `x-opencode-session` header. Out-of-band recap calls now go through Pi's model registry so they use the same authentication and custom endpoints as the main session.
