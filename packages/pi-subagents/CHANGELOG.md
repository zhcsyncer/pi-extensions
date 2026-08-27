# Changelog

## 0.2.0

### Minor Changes

- e037dbe: Upgrade the in-process subagent spawn contract to protocol v3 for orchestrator extensions. Callers can provide an inline role, own completion delivery, correlate lifecycle events, inspect requested/effective model and thinking, discover the runtime concurrency limit, and optionally set per-spawn `graceTurns` after the soft max-turn steer. A side-effect-free `@zhcsyncer/pi-subagents/runtime` entry now exposes the same AgentManager/runAgent execution core to dependent packages without registering Agent tools, commands, scheduling, widgets, or FleetView. Ordinary Agent tools, named/project agents, fallback behavior, completion notifications, FleetView, scheduling, and the global five-turn grace default keep their existing behavior when the new fields are omitted.
- e037dbe: Persist ordinary subagents as parent-linked Pi sessions by default so `/resume` can open their complete conversations, and add a finished-agent history in `/agents` that reopens retained or disk-only runs in the existing brief overlay. Caller-owned terminal events expose the persisted `sessionFile`, and the embedded runtime writes the same finished parent record as the external extension path so orchestrators retain `/agents` history without activating the full extension. Add `rememberAgents` for restoring memory-only defaults. Port the `isolation: "off" | "worktree"` shape with `off` first, and add a repository `worktreeIsolation` capability switch that defaults off in this fork: disabled repositories remove the Agent schema/prose and downgrade tool, agent-file, scheduler, and RPC worktree requests to the real checkout, while enabled worktree creation remains strict.
- e037dbe: Add `pinnedExtensions` so trusted observer extensions (such as pi-meter) stay loaded in every subagent session, including isolated runs, without exposing their tools. Only the user-owned global config may grant observer names; project config can use `[]` to opt out, while non-empty project pins are ignored with a warning so checked-in repositories cannot authorize their own handlers.
- e037dbe: Render Agent / get_subagent_result / steer_subagent transcript rows as unboxed Claude Code Task chrome (`● Type(description)` + a single `⎿` outcome clerk). Collapsed rows keep outcome stats and the resolved model; spawn config, cost, transcript path, and worktree details move to the expanded footer.

## 0.1.5

### Patch Changes

- 0c23485: Add the standalone `@zhcsyncer/pi-herdr-companion` package with immutable runtime context and mode-agnostic process/blocked support that remain strictly silent outside Herdr or with incomplete caller identity, while `/btw` and settings stay TUI-only; branch-safe `herdr_process` panes whose server-scoped terminal identity follows moves across Herdr tabs and workspaces, whose lifecycle cleanup verifies live terminal identity and leaves visible orphans rather than risk closing an unowned Pane, whose provisional starts remain visible and shutdown-cancellable, and whose TUI adds a navigable below-editor process widget plus compact action-aware tool rendering; private self-deleting Bash command scripts on POSIX that prevent Fish or another interactive pane shell from reinterpreting model-authored Bash, a Windows-safe raw default, and an explicit raw-pane escape hatch; ephemeral `/btw` side threads with immediate question submission, inherited parent model/thinking, Pi-default tools, the configured process split direction, and bounded fresh-shell retries, cache-prefix replay with session-neutral parent/child BTW guidance that preserves child handlers, atomic first-session binding, uniquely named candidate locks, conservative stale cleanup, request-deduplicated parent recovery, and acknowledgement-gated child closure; a unified runtime/process/blocked `/herdr-config` TUI at the standard `extension-data/pi-herdr-companion/config.json` path; and generic event/tool blocked rules that preserve unchanged in-flight state across configuration saves. The Subagents FleetView and the Process Widget coordinate below-editor navigation ownership so FleetView does not steal arrow keys after the process list is activated. The root tarball embeds the package sources for release consistency but does not auto-enable the extension.

## Unreleased

### Added

- Ordinary subagents persist as parent-linked Pi sessions by default and remain openable from `/agents`; caller-owned terminal events expose persisted session paths, including through the side-effect-free embedded runtime. Worktree isolation is now an explicit repository capability and defaults off in this fork.
- Trusted observer extensions can be pinned into every subagent session without exposing their tools. Only user-level global config may grant pins; projects may opt out with `[]` but cannot authorize their own handlers.

### Fixed

- Coordinate FleetView keyboard ownership with other below-editor navigators so an activated Herdr Process Widget keeps its arrow-key navigation.
- Manual Agent-tool background completions now use `steer` delivery, including custom agents whose frontmatter resolves to background, so results reach the parent before its next model call instead of starving behind a long tool loop. Scheduled and RPC completions retain detached `followUp` delivery, foreground results remain inline, and the Agent guidance now requires foreground for prerequisite results plus non-overlapping background work with targeted verification rather than repeated evidence collection.

## 0.1.4

### Patch Changes

- eef62a3: Deliver manually launched background Agent completions as `steer` messages so current-task results reach the parent before its next model call instead of starving behind a long tool loop. Scheduled and cross-extension RPC completions retain detached `followUp` delivery, foreground results remain inline, and the Agent contract now requires foreground for prerequisite results plus genuinely disjoint background work without repeating delegated evidence collection.

## 0.1.3

### Patch Changes

- a43cc4c: Improve subagent runtime UI with an honest `working…` fallback, delayed coarse activity phases that do not flicker through exact steps, readable accented durations, and lifetime input/output/cache/cost breakdowns that keep current-context utilization and the existing compact total semantics distinct.

## 0.1.2

### Patch Changes

- 9b1a137: Unify Todo, Ask User Question, and Subagents configuration under each extension's `extension-data/<extension-id>/` directory. Existing global and project files migrate atomically with canonical-path precedence, semantic verification, retained conflicts, and de-duplicated warnings; Subagents runtime resources remain in their existing locations, and Todo now ships aligned English and Simplified Chinese documentation.

## 0.1.1

### Patch Changes

- 44c7eee: Strip ANSI and terminal control sequences from child-agent text before rendering it in the parent TUI.

## 0.1.0

### Minor Changes

- 983adbb: Add a maintained fork of `@tintinweb/pi-subagents@0.14.3` with a ConversationViewer that defaults to dispatch prompt, one-line tool step summaries, and final/current result instead of full tool-result dumps. Failed or cancelled bash executions show as error steps. Compact collapsible TUI for Agent / get_subagent_result / steer_subagent (Markdown when expanded), with model and effort chips on tool call/result rows. Honesty fixes: queued status/activity, failure `isError` shell mapping, resume chips from stored invocation, steered/stopped overlay chrome, dangling-step settle, stricter header peel and failure heuristics. Embed and register the package in the root `@zhcsyncer/pi-extensions` bundle.
