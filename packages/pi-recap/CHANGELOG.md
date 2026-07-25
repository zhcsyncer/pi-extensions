# Changelog

## 0.3.0

### Minor Changes

- da42f35: Add automatic nearest-layer terminal multiplexer naming to recap: Herdr pane labels now take precedence over inherited tmux windows, legacy `tmux` config migrates to `multiplexer`, and ownership-aware restore avoids clobbering later manual renames while handling disable, reload, and shutdown lifecycles.

## Unreleased

### Added

- Added automatic Herdr pane-label synchronization through Herdr's CLI, with Herdr taking precedence over inherited tmux sessions.
- Added ownership-aware restoration, serialized naming updates, failure warnings, and fake-runner contract tests for both supported multiplexers.

### Changed

- Replaced the public `tmux` config group with the shared `multiplexer` group; legacy config migrates automatically and explicit new fields take precedence.
- Restore owned multiplexer names on extension reload and preserve later manual renames during shutdown or runtime disablement.

## 0.2.0

## 0.1.4

### Patch Changes

- 5709a8a: Use the editor widget as the sole persistent recap surface, remove the footer display mode and duplicate success notification, keep manual generation in its cancellable loader, and persistently clean up legacy display config fields.

## 0.1.3

### Patch Changes

- 5e41607: Cancel in-flight automatic recaps when new input starts, prevent stale runs from writing results, and replace the independent widget toggle with mutually exclusive status/widget display modes.

## 0.1.2

### Patch Changes

- 24abac8: Improve the recap widget hierarchy, restore it after reload, and show a cancellable loading indicator while generating manual recaps.

## 0.1.1

- Remove `recap.interactiveOnly`; recap is now always disabled outside TUI mode.
- Split Chinese documentation into `README.zh-CN.md`; `README.md` is English by default.

## 0.1.0

- Initial release.
- Add `/recap` for recent activity recap generation.
- Add automatic idle recap.
- Generate optional session title as a recap side effect.
- Add `/recap-config` and `/recap-config json`.
- Add optional tmux window name sync.
