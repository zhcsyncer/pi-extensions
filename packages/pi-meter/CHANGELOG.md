# @zhcsyncer/pi-meter

## 0.4.0

### Minor Changes

- 8027951: Show Codex banked weekly rate-limit resets in `/usage quota` and the Codex footer, and replace the word "stale" with snapshot age.

## 0.3.1

### Patch Changes

- 4f4fd57: Keep cache write visible in the `/usage` dashboard at typical terminal widths.
- 4f4fd57: Stop `/usage import` from double-counting turns already captured live, and collapse those duplicate ledger rows.

## 0.3.0

### Minor Changes

- 5ebdcf0: Let other extensions register a quota source. The footer follows the current model only.

## 0.2.0

### Minor Changes

- c7bf6cf: Show SuperGrok at 0% used when the weekly percent is omitted, keep the footer on the current model's quota only, and let `/usage footer` switch local spend between rolling and calendar windows.

## 0.1.1

### Patch Changes

- 1768c9d: Consolidate local summary, quota visibility, and used/remaining display under `/usage footer`, and remove the former direct setting arguments.
- 1768c9d: Idle TUI sessions pick up shared quota and local spend from disk on a slow timer, without calling subscription APIs.
- 1768c9d: Show Ollama Cloud remaining in `/usage quota` and the footer for `ollama-cloud` models.
- 1768c9d: Open `/usage quota` in a temporary TUI dashboard so the report does not remain in the chat transcript.
- 1768c9d: Summarize unsigned-in quota providers at the bottom of `/usage quota` instead of treating each missing login as a warning.
- 1768c9d: Show a muted "no quota window" hint in the footer when the current model has no subscription remaining.

## 0.1.0

### Minor Changes

- a16d618: Add `@zhcsyncer/pi-meter`: one `/usage` command for local spend and Claude / Codex / SuperGrok remaining. It combines `pi-tracker` and `@pi-plugins/usage`; disable the latter because both register `/usage`.

## Unreleased

Initial public release will be cut by Changesets from `0.0.0`.
