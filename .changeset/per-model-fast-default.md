---
"@zhcsyncer/pi-extensions": minor
"@zhcsyncer/pi-fast-mode": minor
---

Make Fast Mode defaults per model. `/fast default` sets only the current model's startup default and turns this session's switch to match. Unconfigured models start off. Switching models follows that model's in-memory switch. Old global `enabled` and boolean maps are migrated on startup with a warning; a former global ON does not enable every model.
