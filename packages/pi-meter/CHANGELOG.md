# @zhcsyncer/pi-meter

## 0.4.5

### Patch Changes

- 7a84086: Declare Pi-provided SDK and TypeBox modules as unconstrained host peers instead of bundled runtime dependencies or restrictive host dependency ranges. Development checks now use the verified Pi 1.2.0 SDK graph; installing the package does not enable codemode or MCP.
- 7a84086: Prevent invalid negative historical costs from reducing recorded subtotals and retain recorded usage across branch changes between capture boundaries, without rewriting the original ledger.
- 7a84086: Record finalized Pi 1.1 session usage, including standalone operations with unknown kinds, without double-counting live capture, history imports or reloads. Preserve distinct equal-payload entries, Consult advisor attribution and normal fork origins, while keeping subagent parent rollups non-additive. Retain legacy ledger data and budget compatibility, and distinguish recorded cost subtotals from unknown or incomplete costs. No quota polling or provider changes are included.
- 7a84086: Prevent previously recorded Consult usage from being counted again when an earlier advisor returned no usage. Preserve legacy ledger matching without changing new entry identities or rewriting historical ledger data.
- 7a84086: Avoid counting child usage twice when a native codemode result contains both subagent charges and ordinary parent-tool charges. Meter deducts only valid per-result child usage shares, preserving the parent's own tokens and costs, existing entry identities, and unknown-cost information. SDK session totals and persisted session logs are unchanged.

## 0.4.4

### Patch Changes

- 1192e34: Count compaction and `/tree` branch-summary LLM usage in the local ledger. Live capture listens for those session events; `/usage import` backfills them from session files without double-counting. The usage dashboard shows their share when it is non-zero.

## 0.4.3

### Patch Changes

- 62dbd33: The Ollama Cloud quota card now supports the new credit-based plans that report only a monthly usage window instead of session and weekly windows. Any of the three windows can now be shown on its own, the monthly window note shows recent spend when the API reports it, and the quota dashboard lists the top five per-model request counts under the Ollama monthly window.

## 0.4.2

### Patch Changes

- f3b8c32: Show collected subagent tokens and cost in Pi native session statistics and Glance by default. Foreground Agent results and completed background result retrievals report each agent's unreported lifetime spend once, including resumed sessions. Keep pinned pi-meter observers recording child messages, while excluding duplicate parent usage rollups from live capture and history imports. Native rollups require Pi 0.81.0 or newer and can be disabled with reportUsage.

## 0.4.1

### Patch Changes

- 7b6a072: Account advisor retries, fanout, cache tokens, and cost through Consult tool-result usage so Pi totals include it and pi-meter attributes it to the advisor models.
- 7b6a072: Make `/usage import` report scanned files, parsed records, additions, known duplicates, skipped messages, and whether a repeated import changed the ledger.

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
