# Upstream source

This package was forked from `pi-glance` 0.5.3.

- Repository: https://github.com/LinYS77/pi-glance
- Tag: `v0.5.3`
- Commit: `c342ebebfac20db5059c5017d5a6dc0052b5174c`
- npm package: `pi-glance@0.5.3`
- License: MIT

The production source and upstream tests were copied from that tag before local modifications.

## Local differences

- Preserve statuses published by other extensions while permanently replacing Pi's built-in informational footer rows.
- Add a responsive context progress mode to the input surface bottom-right.
- Add a plain/Nerd Font auto-compaction marker with semantic color highlighting.
- Add a switchable, theme-aware Claude-inspired working indicator for activity, current-cycle output, and elapsed time.
- Add a theme-aware Git Working Tree summary that defaults into the Git status line, with an optional bottom-right border placement, tracked diff statistics, resilient refresh scheduling, and `/diff` revdiff review handoff.
