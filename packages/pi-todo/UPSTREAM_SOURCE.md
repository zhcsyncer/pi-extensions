# Upstream source

This package was forked from `@juicesharp/rpiv-todo` 1.20.0.

- Repository: https://github.com/juicesharp/rpiv-mono
- Upstream package path: `packages/rpiv-todo`
- Tag: `v1.20.0`
- Commit: `060373d9292aeb46aeedc23a6d818a997200a6e5`
- npm package: `@juicesharp/rpiv-todo@1.20.0`
- License: MIT

The production source and upstream tests were copied from that tag before local modifications.

## Local differences

- Successful Todo tool calls/results render no transcript lines; the persistent widget is the sole normal-state presentation.
- Reducer and Pi execution errors remain visible.
- Tool-result `content` and `details` snapshots are unchanged so model feedback, branch-aware replay, and reload recovery keep working.
- The tool intentionally does not use display-intent metadata.
