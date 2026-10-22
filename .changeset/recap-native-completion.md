---
"@zhcsyncer/pi-recap": patch
"@zhcsyncer/pi-extensions": patch
---

Use Pi 1.1's public model-registry completion types and explicit system messages for Recap, preserving model selection, provider authentication, session headers and cancellation. Clarify that Recap currently does not write side-call token usage or costs to Pi session records, so Pi's session usage and cost totals exclude that call. This does not mean it is free: the provider may still charge or consume subscription quota.
