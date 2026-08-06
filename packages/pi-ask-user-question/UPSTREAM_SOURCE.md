# Upstream source

This package was forked from `@juicesharp/rpiv-ask-user-question` 2.4.0.

- Repository: https://github.com/juicesharp/rpiv-mono
- Upstream package path: `packages/rpiv-ask-user-question`
- Commit: `a1531ed4207c21a00941c62571bc1bd3e386cfcb`
- npm package: `@juicesharp/rpiv-ask-user-question@2.4.0`
- License: MIT

The production source and upstream tests were copied from that commit before local modifications.

## Local differences

- The questionnaire uses Pi's normal custom-component layout rather than a bottom-anchored full-screen overlay, so it reflows the transcript and does not paint over the bottom TUI area.
- Number keys `1`–`4` directly choose authored single-select options or toggle authored multi-select options; sentinel rows remain navigation-only.
- The pending tool-call node stays hidden while the interactive questionnaire is active; the completed result renders answers, notes, bounded expanded previews, and errors.
- Content-sized preview boxes are centered within the right-side preview column rather than using upstream's explicit right-edge alignment.
- Collapse remains available as a one-line in-component mode and no longer mutates Pi's overlay stack.
