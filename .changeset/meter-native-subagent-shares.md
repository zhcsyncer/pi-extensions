---
"@zhcsyncer/pi-meter": patch
"@zhcsyncer/pi-extensions": patch
---

Avoid counting child usage twice when a native codemode result contains both subagent charges and ordinary parent-tool charges. Meter deducts only valid per-result child usage shares, preserving the parent's own tokens and costs, existing entry identities, and unknown-cost information. SDK session totals and persisted session logs are unchanged.
