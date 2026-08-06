# Backlog

Repository-level follow-up work that should remain discoverable across sessions.

## Next root bundle release

- [x] Refresh the root bundle and Search Hub documentation before the next release of `@zhcsyncer/pi-extensions`.

  Acceptance criteria:

  - Documentation is bilingual, with English as the default:
    - root: `README.md` in English and `README.zh-CN.md` in Simplified Chinese;
    - Search Hub: `packages/pi-search-hub/README.md` in English and `packages/pi-search-hub/README.zh-CN.md` in Simplified Chinese.
  - The root README clearly explains that the bundle includes the private Search Hub extension and links to its documentation.
  - The Search Hub README explains the local customization relative to upstream, including:
    - integration with `pi-tool-display-intent` and model-written `displaySummary` intents;
    - semantic call lines that display the search query or shortened URL instead of `(N args)`;
    - backend, reader, result-count, combine-health, content-length, and truncation status;
    - inherited global `results.mode` and shared `previewRows` behavior;
    - `web_read.objective` being a Jina CSS selector rather than a natural-language question.
  - Both language versions stay structurally aligned and link to one another.
  - Package file lists and pack checks include both language versions where applicable.
  - Add an appropriate changeset if the documentation update accompanies user-visible behavior changes.

- [ ] Make `@zhcsyncer/pi-ask-user-question` documentation bilingual with English as the default before the next root bundle release.

  Acceptance criteria:

  - Replace the current Chinese-only `packages/pi-ask-user-question/README.md` with:
    - `README.md` in English as the npm/GitHub default;
    - `README.zh-CN.md` in Simplified Chinese.
  - Keep both README heading structures aligned and add reciprocal language links.
  - Preserve upstream documentation separately as `UPSTREAM_README.md`; do not treat it as the maintained English README.
  - Include both maintained README files in the standalone package and root bundle manifests and require both in `scripts/check-pack.mjs`.
  - Add the Ask User Question pair to the bilingual parity check so a missing or structurally divergent translation fails CI.
  - Add an explicit repository-wide rule to `AGENTS.md`: maintained user-facing package documentation is bilingual, with English in `README.md` and Simplified Chinese in `README.zh-CN.md`, unless a documented exception applies.
  - Add the appropriate package and root changeset because the corrected README is user-visible in both npm artifacts.

## `@zhcsyncer/pi-subagents` (post honesty-fix residuals)

Fork display work and adversarial-review P1/P2 honesty fixes are on the branch; these are **not** ship-blockers. Track here so they stay visible before first public cut / root-bundle inclusion.

- [ ] **Redact sensitive args in parent TUI activity / Steps**

  Default widget activity and overlay step summaries currently surface raw bash commands, URLs, and patterns from the child agent. Tokens, passwords, and signed URLs can land in the parent terminal, screenshots, and logs.

  Acceptance criteria:

  - Default collapsed views show a safe summary (e.g. executable + redacted args), not full command lines with secrets.
  - Common secret shapes (bearer/token/password/authorization, obvious URL query secrets) are masked.
  - Full args remain available only behind explicit expand (`o` / Ctrl+O), with no regression to false ✓/✗ status chrome.
  - Unit coverage for at least one bash command containing a token-like value.

- [ ] **Strip ANSI / terminal control sequences from child-sourced display text**

  Tool args and outputs can carry ESC/OSC sequences into parent widget lines and step notes; pi-tui may pass them through.

  Acceptance criteria:

  - Paths that feed parent TUI (`formatActiveToolSummary`, step result notes, undetailed previews) strip C0/C1 and ESC sequences before render.
  - Printable text and normal wide characters still display correctly.
  - A regression test feeds an ESC/OSC payload and asserts it does not appear raw in the rendered line.

- [ ] **Guard against double-loading upstream + fork**

  README warns not to load `@tintinweb/pi-subagents` together with this fork; code does not detect duplicate `Agent` / FleetView registration.

  Acceptance criteria:

  - On extension load, if the same tool names are already registered (or a known upstream marker is present), emit a clear warning naming both packages.
  - Does not hard-crash the session; warning is enough for operator recovery.
  - Documented in package README try steps.

- [ ] **Persist invocation snapshot for schedule / RPC spawns**

  Agents started via schedule (and some RPC paths) may lack `record.invocation`, so `get_subagent_result` cannot show model/effort chips.

  Acceptance criteria:

  - Schedule (and RPC spawn if applicable) attach the same `AgentInvocation` shape as the Agent tool path.
  - `get_subagent_result` call/result chips match a normally spawned background agent when model/thinking were configured on the job.
  - Contract test covers schedule → get_result chip restore.
