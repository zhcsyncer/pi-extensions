---
"@zhcsyncer/pi-glance": minor
---

Split context display into independent `text` and `progress` settings so progress-bar mode keeps a bottom label (always including percent), hide progress style/width until the bar is on, drop the unused `unknown` toggle, and migrate schema 11 configs to version 12.
