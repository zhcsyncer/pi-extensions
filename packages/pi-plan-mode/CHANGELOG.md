# Changelog

## 0.3.1

### Patch Changes

- 44c7eee: Declare and verify compatibility with Pi 0.84 across the bundled extensions.

## 0.3.0

### Minor Changes

- 1683e4f: Unify bundle extension configuration and state under `$PI_CODING_AGENT_DIR/extension-data/<extension-id>/`. Existing global and trusted-project files are migrated and upgraded automatically, unmappable fields are discarded with user-visible warnings, malformed files are preserved, and Plan artifacts remain at `$PI_CODING_AGENT_DIR/plans/`. Search Hub now reads refreshed configuration through Jiti-safe accessors so reader selection, credentials, and round-robin state take effect immediately.

## 0.2.0

### Minor Changes

- 71227ee: Add a branch-aware Plan implementation lifecycle with explicit `complete_plan`, `/plan complete|abandon|revise`, safe legacy-state migration, and new-Plan defaults after work closes. Render `submit_plan` and `complete_plan` as compact self-managed TUI nodes with expandable historical review and completion audit details. Emit balanced Herdr `blocked` events while revdiff, lifecycle selectors, and completion confirmations wait for user input.

## 0.1.0

### Minor Changes

- f3d7b88: Add a temporary read-only Plan Mode with `/plan on|off`, the `--plan` startup flag, keyboard shortcuts, fail-closed tools, revdiff review with word-level revision comparisons, immutable Plan revisions, configurable English or Simplified Chinese Plan content, compact custom-message approval handoff, immediate normal-tool restoration, and collapsible display-only Steps widgets.

## 0.0.0

- Added temporary TUI-only Plan Mode with `/plan on|off`, the `--plan` startup flag, command completion, and `Ctrl+Alt+P` mode switching.
- Added fail-closed read-only planning and revdiff review with explicit approval, Markdown TOC for first revisions, and word-level highlighting for later revision comparisons.
- Added immutable `rN` Plan revisions, SHA-256 approval records, persistent Session pointers, and temporary no-session storage.
- Added a Unicode `⏸` read-only mode bar and a persistent Plan summary with display-only English or Simplified Chinese Steps that expand through `Ctrl+Alt+O`; collapsed summaries hide the Plan path.
- Added user-level `plan-mode.json` configuration for `auto`, `en`, or `zh-CN` Plan content and section headings.
- Restored normal tools immediately after approval and handed off the full approved Plan through a compact displayed custom context message, without execution phases, user-role handoff turns, run commands, Todo integration, or completion tracking.
