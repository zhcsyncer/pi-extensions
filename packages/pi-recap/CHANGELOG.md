# Changelog

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
