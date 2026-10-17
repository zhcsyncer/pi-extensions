# Recorded usage: identity and compatibility boundaries

Meter records finalized session entries, not streaming or execution-event estimates. Pi 1.1 runs extension `message_end` handlers before persisting the message, and a later handler may replace usage. `turn_end` and subsequent lifecycle boundaries observe the finalized journal. Compaction hooks are observation triggers rather than authoritative entry selectors: Pi 1.1 can return an older compaction entry when summaries have identical text.

The additive unit is a session/entry pair, with the original raw-array index for Consult advisor contributions. Outer tool usage already includes nested work. Independent `usage` kinds are open-ended. Summaries charge only their reported generation usage; context compaction and context edits do not erase earlier expenses.

## Parent and copied-session boundaries

Subagent child journals remain canonical. Parent Agent results and marked result-getter rollups are not independent expenses: R1 receipts contain cumulative watermarks and branch-relative claims. Neither a matching amount nor finding some child records proves complete child coverage. Missing child logs remain a coverage limitation, not zero spend or a provisional replacement charge.

Normal SDK fork/clone copies retain entry IDs. The file-reading boundary follows the actual parent file/header and verifies the copied ancestry, allowing the SDK's removal/recreation of labels. A copied expense retains both its source session and source project. A parent link alone does not identify inherited expenses: ordinary Subagents begin a fresh journal and insert inherited context as prompt text. Missing sources are not reconstructed from timestamps or equal payloads. This is local source resolution, not a persisted global provenance registry.

## Legacy compatibility is not historical repair

Old ledger bytes and values remain intact. Read-side duplicate suppression retains the previous budget interpretation without rewriting the file. The previous analytics location is copied only when the current file is absent; its original is retained.

New entries deduplicate exclusively by their finalized identity. Only a complete source snapshot may use actual filename/header aliases, explicit old source IDs and the existing one-to-one unidentified-row compatibility allowance. Incremental live tails cannot repeatedly consume that allowance. These old rules are compatibility behavior, not evidence that equal payloads identify one request. Previously collapsed or miscaptured historical values are not repaired.

Known cost subtotals are retained when complete cost is unavailable. Explicit valid zero differs from missing/invalid cost; an aggregate with any incomplete records is marked accordingly. Neither the ledger nor its existing budget reminders claim to be an exact invoice or a subscription balance.

## Observation boundary

Startup/reload reads the current journal once through the session cursor. Normal updates walk only newly observed ancestry; a changed entry count that cannot be reconciled along that path triggers a history reconciliation (for example a host append followed by navigation between observations). Rendering and unchanged idle sessions do not scan session history. Idle standalone usage is collected at the next public lifecycle boundary, Meter command or orderly shutdown; no polling or provider calls are added.
