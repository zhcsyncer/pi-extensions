# Changelog

## 0.0.0

- Added temporary TUI-only Plan Mode with `/plan on|off`, the `--plan` startup flag, command completion, and `Ctrl+Alt+P` mode switching.
- Added fail-closed read-only planning and revdiff review with explicit approval, Markdown TOC for first revisions, and word-level highlighting for later revision comparisons.
- Added immutable `rN` Plan revisions, SHA-256 approval records, persistent Session pointers, and temporary no-session storage.
- Added a Unicode `⏸` read-only mode bar and a persistent Plan summary with display-only English or Simplified Chinese Steps that expand through `Ctrl+Alt+O`; collapsed summaries hide the Plan path.
- Added user-level `plan-mode.json` configuration for `auto`, `en`, or `zh-CN` Plan content and section headings.
- Restored normal tools immediately after approval and handed off the full approved Plan through a compact displayed custom context message, without execution phases, user-role handoff turns, run commands, Todo integration, or completion tracking.
