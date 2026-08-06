# @zhcsyncer/pi-glance

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
