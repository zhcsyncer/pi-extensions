# Changelog

## Unreleased

Initial public release will be cut by Changesets from `0.0.0`.

- Add stable Herdr runtime context and owned process panes across Pi modes. Managed panes follow their live terminal across Herdr tabs and workspaces, while Pi TUI adds a below-editor process navigator with exact focus, confirmed ownership-safe stop, agent-session warnings, and compact expandable `herdr_process` rendering.
- Add TUI-only ephemeral `/btw` side threads that submit supplied questions immediately, inherit parent model/thinking, use Pi's default tools, and follow the configured process split direction; outside/degraded Herdr sessions remain strictly silent.
- On POSIX, run managed commands through private self-deleting Bash scripts by default so Fish and other interactive pane shells cannot reinterpret model-authored Bash, with an explicit raw `pane` mode and a Windows-safe raw default.
- Add `/herdr-config` for runtime, process, and blocked-source settings with canonical `extension-data/pi-herdr-companion/config.json` storage.
- Add generic event/tool blocked rules that preserve unchanged in-flight state across configuration saves, plus uniquely named cross-process lock candidates.
- Add minimal asynchronous `herdr_worker` dispatch into an existing Pane, with lazy parent naming and explicit reserved final reports delivered to Pi as follow-ups.
