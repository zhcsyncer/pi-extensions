---
"@zhcsyncer/pi-recap": minor
"@zhcsyncer/pi-extensions": minor
---

Add automatic nearest-layer terminal multiplexer naming to recap: Herdr pane labels now take precedence over inherited tmux windows, legacy `tmux` config migrates to `multiplexer`, and ownership-aware restore avoids clobbering later manual renames while handling disable, reload, and shutdown lifecycles.
