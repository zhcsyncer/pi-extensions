# Changelog

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

## Unreleased

### Fixed

- Manual Agent-tool background completions now use `steer` delivery, including custom agents whose frontmatter resolves to background, so results reach the parent before its next model call instead of starving behind a long tool loop. Scheduled and RPC completions retain detached `followUp` delivery, foreground results remain inline, and the Agent guidance now requires foreground for prerequisite results plus non-overlapping background work with targeted verification rather than repeated evidence collection.

Initial public release will be cut by Changesets from `0.0.0`.
