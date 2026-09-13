---
"@zhcsyncer/pi-recap": patch
"@zhcsyncer/pi-extensions": patch
---

Fix tmux name sync failing when window-level automatic-rename is unset. Query the option with `show-window-options -v` because tmux 3.4 rejects `-q` on that command, treat empty output as unset, and restore by unsetting the window option with `-u` instead of writing an empty value.
