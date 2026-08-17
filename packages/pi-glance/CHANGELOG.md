# @zhcsyncer/pi-glance

## 0.8.0

### Minor Changes

- 1768c9d: Glance 输入框增加单槽暂存：快捷键收起/拿回，边框提示未取回内容，同一会话的 /reload 与 resume 后空框自动倒回。

## 0.7.0

### Minor Changes

- 4eff439: Show a separately highlighted `main↓N` when the current branch is behind the last local `origin/main` snapshot, without changing upstream tracking. Hide it when upstream `↓N` is already showing that same lag. Hide the dirty lamp when Working Tree file counts are already visible in the Git status or the bottom-right border; conflict markers stay. Add a Glance screenshot for the pi.dev package gallery.

## 0.6.0

### Minor Changes

- 4099afa: Add a theme-aware Git Working Tree summary that defaults into the Git status line, with an optional bottom-right border placement, tracked diff statistics, event-driven refresh with polling fallback, and a `/diff` revdiff review handoff that returns annotations to the editor for confirmation.

## Unreleased

### Minor Changes

- Add a theme-aware Git Working Tree summary that defaults into the Git status line, with an optional bottom-right border placement, tracked diff statistics, event-driven refresh with safe polling fallback, and `/diff` terminal handoff to revdiff with annotation round-tripping into the editor.
- Keep the working-indicator peak spinner frame on a stable one-column `*` so `Brewing…` no longer shifts right on the old ambiguous `✽` dwell.

## 0.5.0

### Minor Changes

- caf3e9c: Add a switchable, theme-aware Claude-inspired working indicator to Glance, with automatic activity, current-cycle output estimates, human-readable elapsed time with long-cycle emphasis, a first-level settings entry, and parent-preserving pane navigation.

## 0.4.1

### Patch Changes

- 1d5ad9e: Prioritize Glance's dynamic top-border status over the workspace title on narrow terminals while preserving Bash and scroll indicators as the highest-priority interaction cues.

## 0.4.0

### Minor Changes

- 13df227: Split context display into independent `text` and `progress` settings so progress-bar mode keeps a bottom label (always including percent), hide progress style/width until the bar is on, drop the unused `unknown` toggle, and migrate schema 11 configs to version 12.

## 0.3.0

### Minor Changes

- 1683e4f: Unify bundle extension configuration and state under `$PI_CODING_AGENT_DIR/extension-data/<extension-id>/`. Existing global and trusted-project files are migrated and upgraded automatically, unmappable fields are discarded with user-visible warnings, malformed files are preserved, and Plan artifacts remain at `$PI_CODING_AGENT_DIR/plans/`. Search Hub now reads refreshed configuration through Jiti-safe accessors so reader selection, credentials, and round-robin state take effect immediately.

## 0.2.0

### Minor Changes

- 101d68c: Follow Pi theme tokens on new installs, keep normal editor borders aligned with the selected color source while reserving a distinct color for Bash mode, apply the same source consistently to context progress, and improve npm/Pi catalog discovery metadata. Existing configs retain their Glance palette unless Follow Pi is explicitly selected.

## 0.1.0

### Minor Changes

- 801204d: Add the maintained `@zhcsyncer/pi-glance` fork with composable extension statuses, configurable standalone or input-border context progress, one-third or remaining-width layouts, shared 70/85 context risk colors, and a plain/Nerd Font auto-compaction marker with semantic highlighting.
