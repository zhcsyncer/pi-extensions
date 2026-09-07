# Changelog

## 0.1.0

### Minor Changes

- 7b6a072: Add pi-consult, a side-call advisor primitive with consult({ why }), a watchdog, optional dual-path panel, and a local behavior log.

### Patch Changes

- 7b6a072: Link every Consult event to its transcript tool call, record blocked and failed outcomes, and distinguish whether adopted advice changed or confirmed the executor's direction.
- 7b6a072: Limit proactive Consult calls to explicit advisor requests, consequential unresolved choices, or genuinely stuck approaches, and make evidence-based rejection a valid outcome.
- 7b6a072: Follow the user's language in advisor summaries and render Markdown in expanded Consult results while keeping collapsed previews plain.
- 7b6a072: Stream Consult progress as connecting, thinking, or writing with an approximate output-token count, then show exact input, output, and total tokens after completion without cache or cost UI.
- 7b6a072: Rename the advisor budget to perRun with a default of three, retain perTurn as a legacy alias, and distinguish blocked, failed, and cancelled Consult results in the TUI.
- 7b6a072: Replace Consult verdicts with recommend / confirm / revise / stop, rename triggers to onDemand / watchdog, and show trigger, model:effort, exact tokens, retries, and duration on one metadata line in both collapsed and expanded results.
- 7b6a072: Show `/consult status` in a temporary dashboard instead of emitting status text into the transcript.
- 7b6a072: Show consult waiting as consulting + elapsed time, collapse to verdict · summary with Ctrl+O, shrink CONSULT-LOG to adopt|reject | reason, and mirror that decision under the matching Consult row.
- 7b6a072: Account advisor retries, fanout, cache tokens, and cost through Consult tool-result usage so Pi totals include it and pi-meter attributes it to the advisor models.
- 7b6a072: Raise the default watchdog threshold to five and prevent stale evidence from injecting a second Consult steer when Consult itself finishes.
- 7b6a072: Harden consult side calls by preserving user images, requiring consult to run as a standalone prerequisite, enforcing budgets under parallel calls, and making shared event-log updates append-only.
