---
"@zhcsyncer/pi-recap": patch
"@zhcsyncer/pi-extensions": patch
---

Fix tmux name sync failing with "tmux automatic-rename query returned empty output" when automatic-rename is not set at the window level. Empty output is now treated as "unset", and restore unsets the window option with `-u` instead of setting an empty value.
