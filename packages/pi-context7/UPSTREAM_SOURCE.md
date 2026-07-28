# Upstream source

This package was forked from `@upstash/context7-pi` 0.1.2.

- Repository: https://github.com/upstash/context7
- Upstream package path: `packages/pi` (published as `@upstash/context7-pi`)
- Commit: `b250c2515694eee4b6df4db82fa056df9ed3e306`
- npm package: `@upstash/context7-pi@0.1.2`
- License: MIT

The production source, skill, tests, and upstream documentation were copied from that commit before local modifications.

## Local differences

- Published as `@zhcsyncer/pi-context7` and also embedded in the `@zhcsyncer/pi-extensions` root bundle.
- Self-contained compact TUI rendering via local `renderCall` / `renderResult` (no shared display-intent helpers).
- Default collapsed single-line call/result rows with expand-to-full-content via the configured tools expand keybinding.
- Minimal typed tool-result `details` for render metadata only; model-facing `content` text stays aligned with upstream.
- `execute` forwards `AbortSignal` to `fetch`; non-2xx HTTP responses throw so Pi marks tool errors while keeping upstream-friendly messages.
- Removed the `/c7-docs` prompt/slash command; the full `context7-docs` skill is retained.
