---
"@zhcsyncer/pi-meter": patch
---

Count compaction and `/tree` branch-summary LLM usage in the local ledger. Live capture listens for those session events; `/usage import` backfills them from session files without double-counting. The usage dashboard shows their share when it is non-zero.
