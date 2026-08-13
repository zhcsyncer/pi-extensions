# @zhcsyncer/pi-extensions

## 0.17.0

### Minor Changes

- caf3e9c: Add a switchable, theme-aware Claude-inspired working indicator to Glance, with automatic activity, current-cycle output estimates, human-readable elapsed time with long-cycle emphasis, a first-level settings entry, and parent-preserving pane navigation.

## 0.16.1

### Patch Changes

- a43cc4c: Improve subagent runtime UI with an honest `working…` fallback, delayed coarse activity phases that do not flicker through exact steps, readable accented durations, and lifetime input/output/cache/cost breakdowns that keep current-context utilization and the existing compact total semantics distinct.

## 0.16.0

### Minor Changes

- 1d5ad9e: Replace the duplicate `/todos` list command with a `/todo` visual-settings TUI, add atomically persisted widget icon and maximum-height controls, and keep active work visible through priority-aware overflow rendering.

### Patch Changes

- 1d5ad9e: Prioritize Glance's dynamic top-border status over the workspace title on narrow terminals while preserving Bash and scroll indicators as the highest-priority interaction cues.

## 0.15.2

### Patch Changes

- 9b1a137: Unify Todo, Ask User Question, and Subagents configuration under each extension's `extension-data/<extension-id>/` directory. Existing global and project files migrate atomically with canonical-path precedence, semantic verification, retained conflicts, and de-duplicated warnings; Subagents runtime resources remain in their existing locations, and Todo now ships aligned English and Simplified Chinese documentation.

## 0.15.1

### Patch Changes

- 44c7eee: Publish an English default README and a structurally aligned Simplified Chinese README for Ask User Question in both standalone and bundle artifacts.
- 44c7eee: Declare and verify compatibility with Pi 0.84 across the bundled extensions.
- 44c7eee: Strip ANSI and terminal control sequences from child-agent text before rendering it in the parent TUI.

## 0.15.0

### Minor Changes

- 983adbb: Add a maintained fork of `@tintinweb/pi-subagents@0.14.3` with a ConversationViewer that defaults to dispatch prompt, one-line tool step summaries, and final/current result instead of full tool-result dumps. Failed or cancelled bash executions show as error steps. Compact collapsible TUI for Agent / get_subagent_result / steer_subagent (Markdown when expanded), with model and effort chips on tool call/result rows. Honesty fixes: queued status/activity, failure `isError` shell mapping, resume chips from stored invocation, steered/stopped overlay chrome, dangling-step settle, stricter header peel and failure heuristics. Embed and register the package in the root `@zhcsyncer/pi-extensions` bundle.

## 0.14.0

### Minor Changes

- 992463b: Publish a maintained structured-question fork with a non-overlay TUI layout, context-aware number-key selection, centered preview columns, and readable expandable post-interaction result rendering, and include it in the aggregate extension bundle.

## 0.13.0

### Minor Changes

- 13df227: Add `diff.collapsedMode` to `pi-tool-display-intent`. When set to `summary`, edit and write diffs collapse to a single `↳ diff +N -M • H hunks • F files` stats line (plus a `Ctrl+O to expand` hint) before expansion, instead of the first `diff.collapsedRows` rows. The default `body` keeps the existing preview. The setting is exposed in the `/tool-display-intent` inspector as "Diff collapsed style" and rounds-trips through the v2 config; invalid values fall back to `body`.

## 0.12.1

### Patch Changes

- c75a5d8: Keep path-bearing built-in tool call headers compact at narrow widths. Collapsed `read`, `grep`, `find`, `ls`, `edit`, and `write` calls now abbreviate middle path segments while preserving useful anchors and the basename; expanding tools with `Ctrl+O` restores the complete path.
- c75a5d8: Improve Bash transcript readability in Claude-style rendering. Separate command previews now emphasize their shell prompt, expanded commands use bounded Bash syntax highlighting, and Bash result gutters connect through the final row in collapsed and expanded views. The shared `results.previewRows` setting now exposes and enforces a minimum of two rows.
- c75a5d8: Restore built-in `promptSnippet` and `promptGuidelines` when overriding tools for display. Overrides now read metadata from Pi ToolDefinitions instead of wrapped AgentTools, so `read`, `write`, and the other owned tools reappear in the system prompt `Available tools` section.
- c75a5d8: Keep generic and MCP failures visible in every result mode. Failed tools now render one content-derived error summary even when compact mode hides successful output, while `Ctrl+O` reveals the complete error content through the existing expanded preview budget.

## 0.12.0

### Minor Changes

- b7677c4: Add Context7 documentation tools with compact self-contained TUI rendering and the full upstream skill. The package publishes as `@zhcsyncer/pi-context7` and is also embedded in the root extension bundle.

## 0.11.0

### Minor Changes

- 1683e4f: Unify bundle extension configuration and state under `$PI_CODING_AGENT_DIR/extension-data/<extension-id>/`. Existing global and trusted-project files are migrated and upgraded automatically, unmappable fields are discarded with user-visible warnings, malformed files are preserved, and Plan artifacts remain at `$PI_CODING_AGENT_DIR/plans/`. Search Hub now reads refreshed configuration through Jiti-safe accessors so reader selection, credentials, and round-robin state take effect immediately.

## 0.10.0

### Minor Changes

- 71227ee: Add a branch-aware Plan implementation lifecycle with explicit `complete_plan`, `/plan complete|abandon|revise`, safe legacy-state migration, and new-Plan defaults after work closes. Render `submit_plan` and `complete_plan` as compact self-managed TUI nodes with expandable historical review and completion audit details. Emit balanced Herdr `blocked` events while revdiff, lifecycle selectors, and completion confirmations wait for user input.

## 0.9.0

### Minor Changes

- 101d68c: Follow Pi theme tokens on new installs, keep normal editor borders aligned with the selected color source while reserving a distinct color for Bash mode, apply the same source consistently to context progress, and improve npm/Pi catalog discovery metadata. Existing configs retain their Glance palette unless Follow Pi is explicitly selected.

### Patch Changes

- 101d68c: Allow Todo batches to create and start their first task in one operation, accept pending-to-completed reconciliation, remove the redundant activeForm field with legacy replay compatibility, add configurable ASCII, Unicode, and animated Nerd Font icons with static Todo headings and status-aware theme styling, and improve npm/Pi catalog discovery metadata.

## 0.8.0

### Minor Changes

- da42f35: Turn `/search-setup` into Search Hub's combined status and configuration dashboard, remove the separate `/search-status` command and footer activity, add ordered default-reader fallback, simplify search routing into fallback/targeted/all modes, and remove the unused local search-result cache and cache settings. Backend rows now expose switch, unified resolved-auth readiness, URL, and project-override status up front; unresolved references display as no credential. Detail menus separate credential management from enablement and show global versus effective state, while Codex search resolves its credential through the current Pi model registry. Backends now live on a dedicated second-level page. All setup pages share one in-memory draft, and `Save & apply` validates and atomically writes once; closing with dirty state offers save, discard, or continued editing. Backend disablement remains reversible, and blank required credentials cannot enable a backend.
- da42f35: Add automatic nearest-layer terminal multiplexer naming to recap: Herdr pane labels now take precedence over inherited tmux windows, legacy `tmux` config migrates to `multiplexer`, and ownership-aware restore avoids clobbering later manual renames while handling disable, reload, and shutdown lifecycles.
- da42f35: Make Todo reliable for multi-stage work: isolate state per SDK session runtime, enforce lifecycle and dependency contracts, add atomic batch mutations, report validation failures as tool errors, and expose hidden successful calls in expanded audit views. Single-step work is now explicitly excluded from Todo guidance.

## 0.7.0

### Minor Changes

- f3d7b88: Add a temporary read-only Plan Mode with `/plan on|off`, the `--plan` startup flag, keyboard shortcuts, fail-closed tools, revdiff review with word-level revision comparisons, immutable Plan revisions, configurable English or Simplified Chinese Plan content, compact custom-message approval handoff, immediate normal-tool restoration, and collapsible display-only Steps widgets.

## 0.6.0

### Minor Changes

- 801204d: Add the maintained `@zhcsyncer/pi-glance` fork with composable extension statuses, configurable standalone or input-border context progress, one-third or remaining-width layouts, shared 70/85 context risk colors, and a plain/Nerd Font auto-compaction marker with semantic highlighting.

## 0.5.1

### Patch Changes

- 9165916: Reduce prompt overhead for model-written tool intents. Wrapped tools now share one Pi-deduplicatable guideline, preserve their original descriptions, and retain detailed `displaySummary` field guidance in each schema. This trims the initial bundle prompt without changing execution, RPC, fallback, or rendering semantics.

## 0.5.0

### Minor Changes

- c1b1172: Collapse long and multiline Bash call arguments into a width-aware preview with line and size metadata, while letting Ctrl+O reveal the complete original command. Add `toolCalls.bashCommandPreviewRows` to control the collapsed command budget and keep Claude-style intents in an intent-first header.

  Emphasize model-written tool intents with the theme accent color while rendering deterministic commands, paths, and queries as normal text and retaining muted fallback intents.

### Patch Changes

- c1b1172: Add structurally aligned English and Simplified Chinese documentation for the root bundle and its private Search Hub fork. Document Search Hub's intent-aware semantic call lines, backend and reader result status, inherited display modes, shared preview budget, and Jina CSS selector semantics, and verify both README variants in npm pack checks.
- 7a843b3: Remove release-version pins from every maintained README installation command so users always install the current repository release without documentation churn. Remove the version-time README rewrite and add a pack check that prevents pinned installation examples from returning.

## 0.4.0

### Minor Changes

- 3849eba: Integrate the bundle-private Search Hub tools with model-written display intents and shared result rendering. Custom tool providers can now set `outputMode: "inherit"` through the cooperative consumer API so their result display follows the global `results.mode` without requiring per-tool user configuration, and can provide structured call targets, metadata, result statuses, and duplicate-header offsets while retaining shared styling and preview budgets. Search Hub uses these hooks to display queries, shortened URLs, backend/reader details, counts, combine health, and truncation state instead of generic argument counts, and now documents `web_read.objective` consistently as a Jina CSS selector rather than a natural-language question.

## 0.3.0

### Minor Changes

- 04800e0: Replace the flat tool-display configuration with a strictly validated, grouped, sparse v2 format. Existing configs migrate atomically with a one-time backup and status-bar guidance for the removed `bashCollapsedLines` field. Tool results now use one `compact | summary | preview` mode and a shared wrapped-row `previewRows` budget across read, search, MCP, custom, and bash output, preventing extremely long single-line results from flooding the transcript. The bundled JSON Schema uses direct field names, debug reads the real user config, and thinking labels remain independently configurable.
- 88a9366: Publish a maintained fork of `@juicesharp/rpiv-todo` 1.20.0 as `@zhcsyncer/pi-todo` and include it in the aggregate bundle. Todo keeps branch-aware tool-result snapshots but hides successful transcript nodes in favor of its persistent widget, while preserving visible errors and intentionally avoiding display-intent metadata.

## 0.2.0

### Minor Changes

- c1bafff: Add the `pi-tool-display-intent` extension and include it in the root bundle. The new package combines compact tool rendering with model-written, RPC-visible intent phrases without an extra inference request, preserves deterministic TUI metadata, keeps intent examples in model context for reliable follow-up calls, provides deterministic fallbacks and an optional Claude Code-inspired TUI style, sanitizes outgoing display text, and provides a cooperative custom-tool wrapper. Its built-in intent configuration uses the focused `toolIntent.enabled`, `toolIntent.language`, and `toolIntent.maxLength` surface, with enabled intent always required and visible in TUI and legacy `displaySummary` config migrated on load. Model-written intent uses the theme's primary text color for stronger contrast, while deterministic fallback intent remains muted. Output profiles only update read/search/MCP/bash density and preserve style, intent, ownership, diff, and advanced preferences; the separate reset command restores complete defaults.

## 0.1.4

### Patch Changes

- 5709a8a: Use the editor widget as the sole persistent recap surface, remove the footer display mode and duplicate success notification, keep manual generation in its cancellable loader, and persistently clean up legacy display config fields.

## 0.1.3

## 0.1.2

### Patch Changes

- 24abac8: Improve the recap widget hierarchy, restore it after reload, and show a cancellable loading indicator while generating manual recaps.
