# Changelog

## 0.2.0

### Minor Changes

- 1569e96: Add `/herdr-worktree cleanup` to remove the current linked Herdr worktree. By default it also deletes the local branch; `--keep-branch` keeps the branch. Remote branches are left untouched.
- 1569e96: Add `/herdr-worktree start` to distill an executable plan from the current session, then create a linked worktree and start Pi with only that plan.

## 0.1.0

### Minor Changes

- 0c23485: Add the standalone `@zhcsyncer/pi-herdr-companion` package with immutable runtime context and mode-agnostic process/blocked support that remain strictly silent outside Herdr or with incomplete caller identity, while `/btw` and settings stay TUI-only; branch-safe `herdr_process` panes whose server-scoped terminal identity follows moves across Herdr tabs and workspaces, whose lifecycle cleanup verifies live terminal identity and leaves visible orphans rather than risk closing an unowned Pane, whose provisional starts remain visible and shutdown-cancellable, and whose TUI adds a navigable below-editor process widget plus compact action-aware tool rendering; private self-deleting Bash command scripts on POSIX that prevent Fish or another interactive pane shell from reinterpreting model-authored Bash, a Windows-safe raw default, and an explicit raw-pane escape hatch; ephemeral `/btw` side threads with immediate question submission, inherited parent model/thinking, Pi-default tools, the configured process split direction, and bounded fresh-shell retries, cache-prefix replay with session-neutral parent/child BTW guidance that preserves child handlers, atomic first-session binding, uniquely named candidate locks, conservative stale cleanup, request-deduplicated parent recovery, and acknowledgement-gated child closure; a unified runtime/process/blocked `/herdr-config` TUI at the standard `extension-data/pi-herdr-companion/config.json` path; and generic event/tool blocked rules that preserve unchanged in-flight state across configuration saves. The Subagents FleetView and the Process Widget coordinate below-editor navigation ownership so FleetView does not steal arrow keys after the process list is activated. The root tarball embeds the package sources for release consistency but does not auto-enable the extension.

## Unreleased

Initial public release will be cut by Changesets from `0.0.0`.

- Add stable Herdr runtime context and owned process panes across Pi modes. Managed panes follow their live terminal across Herdr tabs and workspaces, while Pi TUI adds a below-editor process navigator with confirmed ownership-safe stop, agent-session warnings, and compact expandable `herdr_process` rendering.
- Add TUI-only ephemeral `/btw` side threads that inherit parent model/thinking, use Pi's default tools, and follow the configured process split direction; a supplied question is submitted only after the child is interactively ready, so launch cannot time out while that first turn is still working. Outside/degraded Herdr sessions remain strictly silent.
- On POSIX, run managed commands through private self-deleting Bash scripts by default so Fish and other interactive pane shells cannot reinterpret model-authored Bash, with an explicit raw `pane` mode and a Windows-safe raw default.
- Add `/herdr-config` for runtime, process, and blocked-source settings with canonical `extension-data/pi-herdr-companion/config.json` storage.
- Add generic event/tool blocked rules that preserve unchanged in-flight state across configuration saves, plus uniquely named cross-process lock candidates.
- Verify live terminal identity before lifecycle cleanup closes a managed Pane; when verification fails, leave the visible process for manual cleanup instead of risking an unowned Pane.
