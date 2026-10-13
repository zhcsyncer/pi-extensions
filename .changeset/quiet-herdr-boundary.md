---
"@zhcsyncer/pi-herdr-companion": patch
---

Require Pi 1.1+ and make `herdr_process` model-only: direct calls retain owned-process management, while nested calls from other tools are rejected before any management action. Preserve sequential execution, BTW behavior, and the existing Herdr state bridge.
