---
"@zhcsyncer/pi-fast-mode": patch
"@zhcsyncer/pi-extensions": patch
---

Simplify Fast Mode for Pi 1.2+: request same-model priority through the main-session request hook instead of replacing providers or maintaining a local output-budget implementation. Keep per-model switches, settings defaults and Ctrl+F repeat protection. Turning Fast off leaves user-supplied tiers untouched. Direct SDK calls from extensions such as Consult and Recap are outside this scope, and local cost estimates may differ from provider billing.
