# Adversarial Review reference

[简体中文](./REFERENCE.zh-CN.md) · [Back to README](./README.md)

This document specifies the command, runtime, gating, UI, audit, and Git-safety behavior of `@zhcsyncer/pi-adversarial-review`.

## Command model and runtime surface

`/adversarial-review` is a Pi extension slash command. It is not registered as an LLM tool, and the main model never emits an `adversarial-review` tool call. If the command is not invoked, Review adds no Agent tool, prompt, scheduler, background process, or FleetView surface to the main session.

After preflight, target freezing, and route selection, Review sends caller-owned spawn requests through either a compatible Subagents protocol-v3 runtime or the embedded adapter. The role input has this conceptual shape:

```ts
{
  role: "reviewer" | "refuter" | "format-repair",
  prompt: "trusted orchestration instructions, or format-repair data only",
  systemPrompt: "trusted reviewer/refuter charter, or format-only policy",
  cwd: "repository root or detached range worktree",
  model: selectedModel,
  thinking: exactThinkingLevel,
  maxTurns: boundedTurnLimit,
  graceTurns: wrapUpTurnsAfterSteer,
  correlationId: "run-id:role:ordinal",
  description: "display-only route/finding description"
}
```

Each request creates a fresh session with an inline agent configuration:

```ts
{
  builtinToolNames: ["read", "grep", "find", "ls"],
  extensions: false,
  skills: false,
  promptMode: "replace",
  persistSession: config.persistRouteSessions // default false
}
```

Reviewer/refuter agents therefore do not inherit the main conversation and cannot call `bash`, `edit`, `write`, Agent, or extension tools. The trusted system prompt is separate from the frozen patch, repository text, requirement document, focus, findings, and marker-like text, all of which remain untrusted data. Format-repair agents are stricter: their built-in tool list is empty, extensions and skills are disabled, and they receive no frozen-input path or review assignment.

Route child sessions are memory-only by default, independently of Subagents' ordinary-agent default. The user-owned `$PI_CODING_AGENT_DIR/extension-data/pi-adversarial-review/config.json` may contain `{ "persistRouteSessions": true }`; the default path is `~/.pi/agent/extension-data/pi-adversarial-review/config.json`. No project config can enable this privacy/storage behavior. Missing means `false`; malformed JSON, unknown fields, or non-boolean values fail the command. When enabled, reviewer, refuter, and format-repair sessions use standard parent-linked Pi persistence, appear in `/agents` after completion through both external and embedded backends, and expose their runtime-owned session paths in audit records.

Caller-owned delivery changes only who receives the terminal result. Queueing, stop, history, FleetView, and terminal lifecycle remain managed by Subagents when the external backend is selected. The runtime validates that requested and effective provider/model/thinking identities match the chosen route before accepting a terminal report.

## Git preflight and target inference

Preflight runs before the reviewer picker. Without an explicit target it:

1. selects the current branch's upstream remote, then `origin`, then a sole remote;
2. fetches that remote through a hardened process;
3. identifies the remote default branch from remote HEAD, `main`, or `master`;
4. asks TUI users when remote HEAD is absent and both `main` and `master` exist;
5. compares the current branch with the selected default branch and chooses a candidate target.

A normal feature branch reviews committed changes from the remote default branch plus staged, unstaged, and untracked work. A synchronized default branch reviews local work only. Commits already reachable from HEAD are committed history and require no additional commit; they are included whenever the chosen target covers them. When staged, unstaged, or untracked work exists, whole/local targets include it automatically without asking to commit first. A committed range instead asks users to continue while excluding that work or cancel, commit, and rerun. Local commits or divergence on the default branch, detached HEAD, an in-progress Git operation, unmerged files, and ambiguous remote/default-branch state require a TUI decision. Headless modes fail loud and require an explicit target for those states. When an inferred or interactively chosen default-branch-to-HEAD target is large and contains branch commits, ordinary TUI setup offers a continuous fixed-HEAD commit line; it does not invoke automatic commit planning. If it contains only local changes, TUI offers whole-target review or cancellation instead of an empty range picker.

If fetch fails, TUI offers Retry, use the existing local remote-tracking ref, or Cancel. Escape cancels an in-flight preflight/fetch immediately. Headless modes fail loud. Preflight never merges, rebases, resets, checks out, or prunes.

Bare `--range` opens the same TUI commit line directly. It fixes B to the captured full `HEAD` SHA and displays every available first-parent commit newest-first as `Start <short-sha> · reviews N commits · <committer-time> · <subject>`. The timestamp is Git's strict ISO-8601 committer time, shown with its recorded UTC offset. Any row can be the earliest included commit, so 3, 6, or any other available continuous count is selectable without presets. Internally A is the selected commit's complete first-parent SHA, so the shown start commit is included without asking users to reason about Git's exclusive `A..B` left endpoint. The selected start-to-HEAD range remains one review target and one report; it is never silently replaced by automatic batches. On a feature branch, preflight first refreshes the preferred remote and limits choices to commits after the HEAD/default-branch merge-base. If that boundary cannot be proven, or the repository is shallow, TUI explicitly says choices use only locally available first-parent history. At most 128 choices are shown. Detached HEAD, an active Git operation, unmerged files, and root-only history are rejected before model selection. Local staged/unstaged/untracked work is excluded; before showing the commit line, TUI requires an explicit choice between continuing with committed history only and cancelling to commit that work first. Outside TUI, bare `--range` fails and exact `--range A..B` remains required.

The chosen target, branch, ahead/behind counts, fetch state, and measured input size are displayed before execution and recorded in the report. HEAD, branch, exact status, selected ref SHAs, target hash, and frozen input hash are revalidated after model selection and immediately before spawn. If Git changes while the picker is open, TUI reruns preflight. A later mismatch fails before any reviewer starts.

Remote/ref and bare-range commit-line labels use stable picker values; shortened display labels are never used to recover the selected Git identity. Explicit-target commit-plan rows likewise bind to complete immutable SHA pairs. Commit subjects are untrusted display metadata: control/bidirectional characters are neutralized and long subjects are code-point safely truncated; labels never participate in identity recovery.

## Reviewer and Refuter selection

TUI setup requires 2–8 exact reviewer routes from `ctx.scopedModels`. Every unremembered model starts `disabled`. Its first enabled state is `medium`, or the nearest level returned by Pi AI's thinking-level clamp when `medium` is unsupported. Later cycling exposes every supported level. A scope-pinned model can use only `disabled` or its pinned level. The value column keeps `disabled` dim and highlights every enabled thinking level, including `off`, so an enabled route is not visually the same as an unused one.

Valid choices are remembered only for the current Pi session. Removed scope entries are pruned immediately and are not resurrected if later re-added.

The same setup picker controls **Refute blocking findings**:

- **main session** (default) uses the current main model and exact current thinking level in a fresh session;
- **choose model** opens a scoped single-route picker after reviewer confirmation;
- **disabled** skips Refute.

If the main-session model/thinking route is missing or incompatible, setup falls back to **choose model** instead of blocking ordinary Review. Escape from either picker cancels before any reviewer starts.

Explicit `--reviewer` flags bypass the combined setup picker. In TUI, `--refute` without `--refuter` uses the main-session route when compatible and otherwise opens scoped refuter selection. Outside TUI, routes must be explicit and reproducible.

## Review strategy and finding ratings

Every reviewer receives the same complete charter at trusted system-prompt priority, the same frozen evidence, and the same task instructions. Each route must independently perform a full review covering:

- trust boundaries and abuse resistance;
- state and data integrity;
- concurrency and failure recovery;
- compatibility and operations;
- general correctness and any other material regression.

There is no route-specific division of responsibility or hidden focus assignment. A reviewer cannot assume another route covers an area. Selected routes may use different models or thinking levels, but their review scope and evidence are identical; clustering and votes happen only after each complete review, so agreement represents independent corroboration rather than coordinated specialization.

An initial `invalid-output` result is first checked locally without a model call. Only complete, untruncated raw text containing exactly one complete schema-valid ReviewReport receives one same-model/same-thinking format-repair attempt. This is not another review: the repair prompt contains only the parser error and JSON-encoded original output, uses a separate tool-free role, and never includes the frozen target or charter. The retry must parse to the identical normalized report. Missing/truncated source, zero or multiple valid reports, invention, dropped findings, or any changed semantic value fail closed; source-preflight failures spend no repair turn, and no route receives a third attempt.

Requirements are product-contract evidence and `--focus` adds the same shared emphasis to every reviewer. Neither can override the charter, suppress another material finding, or turn repository instructions into trusted policy.

Findings separate three axes:

- **Severity (impact):** `critical` means systemic compromise, broad authorization bypass, widespread irreversible data harm, or unrecoverable service failure; `high` means serious harm on a realistic path; `medium` means meaningful but bounded or conditional impact; `low` means narrow yet material behavioral impact, never style or cleanup.
- **Confidence (evidence):** `0.95–1.00` is direct end-to-end code evidence; `0.85–0.94` leaves only routine inference; `0.70–0.84` has one identified assumption; `0.50–0.69` is incomplete and should be reported only with the missing proof stated; lower scores are too speculative to report.
- **Votes (corroboration):** the number of independent reviewer routes represented in a conservative cluster.

A valid finding also contains a repository-relative file and line range, category, violated invariant, material issue and impact, concrete evidence, and a practical correction direction.

## Gating and Refute semantics

Review reports are schema- and semantics-validated before convergence. Clustering is deliberately precision-first: findings are merged only when file, category, location, and mechanism safely agree. Distinct issues may remain separate rather than creating false consensus.

Under `weighted` gating, a cluster is blocking when it reaches:

```text
max(2, ceil(validReviewers / 2))
```

independent votes, or when one original finding itself has `critical`/`high` severity and confidence at least `0.85`. Severity from one report and confidence from another can never be spliced into the single-high exception. Other valid clusters are advisory, although advisories spanning a reviewer quorum still require adjudication. Under `strict`, every valid cluster is blocking.

Refute runs only when requested, a compatible route exists, the gate produced blocking findings, and the review is not stale, cancelled, or failed. Each blocking cluster receives a fresh isolated refuter session. A refuter tries to falsify that exact finding with concrete code evidence; it does not perform a second general review.

`refuted=true` means the challenge was supported by the refuter's validated output. Review records the finding as contested but does not delete, downgrade, or unblock it. `false`, provider failure, timeout, cancellation, and invalid output all leave the original finding unchanged. The current main model or user is the final adjudicator.

If no blocking finding exists, Refute is explicitly reported as skipped and no refuter model is spent. Completed runs show valid refuter attempts and contested count, including zero.

## Command options

| Option | Meaning |
|---|---|
| `--local` | Explicit local/offline target: staged, unstaged, and untracked changes; no fetch and no commits. |
| `--base <ref>` | Committed changes from the merge base of `<ref>` and HEAD, plus local changes. Remote-tracking refs are refreshed first. |
| `--range` | TUI-only commit line ending at captured `HEAD`; choose any earliest included first-parent commit. |
| `--range <A>..<B>` | Exact committed-only range, reviewed from an extension-owned detached linked worktree at B. |
| `--reviewer <provider/model>@<thinking>` | Exact reviewer route; repeat 2–8 times. |
| `--refute` | Request independent Refute if blocking findings pass the gate. |
| `--refuter <provider/model>@<thinking>` | Exact scoped refuter route; requires `--refute`. |
| `--reqdoc <path>` | Attach a regular requirement file inside the repository. Symlink escape is rejected. |
| `--focus <text>` | Add shared, untrusted review emphasis. |
| `--gating weighted\|strict` | Select convergence gate; default is `weighted`. |
| `--allow-large` | Explicitly accept a target above the recommendation in headless modes. It cannot override the hard limit or range checkout capacity gates. |

Target options are mutually exclusive and override inference. Bare `--range` interactively chooses any continuous start-to-HEAD count; `--range HEAD~5..HEAD` is its reproducible exact equivalent for five commits. `--local` includes no commits. Without reviewer flags, reviewer selection requires TUI. Outside TUI, provide an exact target and at least two `--reviewer` options. Headless Refute requires both `--refute` and `--refuter`.

Examples:

```text
/adversarial-review --local

/adversarial-review \
  --base origin/main \
  --reviewer anthropic/claude@high \
  --reviewer openai/gpt@high \
  --reqdoc docs/feature.md \
  --focus "failure recovery" \
  --gating strict
```

## Target freezing and range worktrees

All routes read one immutable frozen input containing run metadata, the trusted charter copy, optional requirement/focus data, changed-file names, raw patches, and the output contract. The input path is private to the run. Reviewers receive the path and must read it completely before deciding.

`--local` and `--base` keep reviewer inspection in the live repository root but freeze all review evidence before spawn. They never change the user's HEAD, branch, index, tracked files, or untracked files.

`--range A..B` is committed-only. Bare `--range` resolves its selection immediately to immutable full `parent(oldest)..HEAD_SHA` endpoints and then follows this same path. The current worktree must be on a named branch and B must be an ancestor of that branch's current HEAD. Detached HEAD and divergent or unrelated B are rejected before model selection.

Every range, including a clean B=current-HEAD range, creates one extension-owned detached linked worktree at exactly B under the private run directory. All reviewer and refuter routes share that read-only inspection view. The user's real repository root is never reused for range inspection and is never switched or rewritten.

The frozen raw Git patch remains the authoritative evidence. Binary, LFS, submodule, sparse/missing-object, and patch-context limitations are recorded in `limitedContext` rather than hidden.

## Input limits, turns, and timeouts

The recommended whole-target threshold is 200 KiB or 5,000 logical lines. It is a quality and resource signal: the same patch and context are copied to 2–8 isolated reviewers, so large inputs multiply provider cost, latency, memory, and dilution risk. Measurements use deterministic UTF-8 bytes and logical lines rather than provider-specific token estimates.

For either TUI entry into the fixed-HEAD commit line, the user's continuous start-to-HEAD selection remains authoritative. Above the recommendation but below 1 MiB / 25,000 lines, TUI offers **Review all N selected commits together**, **Choose a closer start commit**, or Cancel. Whole-range confirmation receives large-target turns/timeouts. Above the absolute limit, the same commit line reopens with only closer starts; a single commit that exceeds the limit cannot run until attached context is reduced or that commit is split. The commit list is queried once against the captured HEAD and reused for re-selection. Automatic commit planning is disabled on this path.

Explicit large `--base` or `--range A..B` targets retain **Review by commit plan** as a deterministic diagnostic for users who intentionally want separate runs. Its rows remain complete frozen-bundle measurements bound to full SHA pairs. Analysis is capped at the first 128 first-parent commits and eight plan items; incomplete coverage is reported explicitly. Headless modes never choose implicitly: pass an exact `--range`, or `--allow-large` only when the target remains below the absolute limit.

| Role / target | Max turns | Grace turns | Per-route timeout | Overall timeout |
|---|---:|---:|---:|---:|
| Reviewer / ordinary | 25 | 15 | 10 min | 20 min |
| Reviewer / approved large | 40 | 20 | 20 min | 30 min |
| Format repair | 3 | 2 | 2 min max | remaining reviewer deadline |
| Refuter / ordinary | 12 | 10 | 5 min | 15 min |
| Refuter / approved large | 20 | 15 | 10 min | 30 min |

Review sends these per-spawn grace turns through the existing Subagents spawn path. Ordinary Agent tools keep the global five-turn default when the field is omitted. Reaching `maxTurns` still steers the route to wrap up immediately; hard abort happens only after `maxTurns + graceTurns`. Wall-clock deadlines still bound wrap-up behavior. A terminal event with `steered` status is accepted only after the same identity and output checks and is recorded as `turnLimited`. Format repair does not extend the reviewer overall deadline: its wave receives only the remaining wall-clock budget.

When commit planning is requested, or the hard limit is exceeded, diagnostics report only dimensions actually over the relevant threshold. SHA-bound, non-empty bounded replacements are measured as complete frozen bundles against the 200 KiB / 5,000-line recommendation; large single commits are additionally measured against the absolute limit. TUI preserves every non-target option automatically after selection; copied headless commands must do the same. Base plans cover committed changes only and explicitly warn that uncommitted work still needs `--local`. If one commit exceeds the hard limit, reduce attached context or split that commit.

## TUI lifecycle and cancellation

Review uses four display surfaces with distinct responsibilities:

1. **Paused editor replacement:** the single compact phase, completed/running/queued count, elapsed time, one-line discrete `Snapshot → Review → Gate → Finish` stepper, target, frozen input size, deterministic gate/Refute outcomes, cleanup state, and `input paused · Esc to cancel`. Refute is inserted only after it actually starts. Finish covers report publication and the real cleanup barrier. This is stage visibility, never a percentage or time estimate. Review does not occupy Pi's footer status area or register a separate above-editor widget.
2. **Subagents Agents/FleetView:** when the external backend is active, this exclusively owns per-agent model, execution, conversation, token, and tool-step detail; the Review card does not duplicate agent rows. The embedded fallback has no FleetView, so the same editor card retains bounded per-agent status there.
3. **Dispatch transcript entry:** immediately before the first reviewer spawn, a durable `adversarial-review-dispatch` entry records the run ID, exact frozen target, input size, requested routes, backend, gate, and Refute selection. It is readable and expandable but does not participate in model context.
4. **Terminal transcript entry:** the durable `adversarial-review-result`, cancellation, or error entry closes the visible lifecycle. A collapsed non-success report shows route failures immediately; expansion shows every route outcome, duration/usage, complete blocking/advisory findings, Refute, and target details. The adjudication handoff is a separate hidden custom message, so the visible report is not duplicated.

The editor card is bounded to ten content lines plus the pause/cancel hint. Embedded overflow points to the final report. Control characters are sanitized, full Git identities remain in the audit/report while the transient card uses short identity hints, and long lines are terminal-width truncated. Intermediate card state is ephemeral and is not appended to model context; dispatch and terminal entries are durable without entering model context.

During freeze, review, and refute, Escape opens an explicit cancellation choice without stopping work. **Continue review** is selected by default. Enter on that choice, or Escape from the confirmation screen, returns to the same running operation. Only **Confirm cancellation** aborts the shared run signal.

External shutdown bypasses confirmation. In all cases, UI acknowledgement is not terminal truth: the command waits for agent terminal settlement, Git process exit, runtime disposal, and frozen workspace cleanup. The editor card remains until that barrier completes and is then replaced by the normal editor; cleanup failure retains recoverable resources and emits a warning. A post-freeze cancelled report is persisted as partial audit evidence but never wakes the main model or queues adjudication. Git preflight and reviewer/refuter pickers retain immediate Escape cancellation.

## Reports and parser contract

Every reviewer and refuter attempt is retained, including provider errors, timeouts, cancellation, and invalid output. Reviewer output normally must be one bare JSON object whose first and last non-whitespace characters are `{` and `}`. When format repair runs, both the original invalid attempt and retry terminal record are retained under that route; top-level route duration/usage includes both. When route-session persistence is enabled, each attempt also records its runtime-owned child-session path.

As a narrow provider-robustness fallback, the reviewer parser also accepts leading prose followed by exactly one `json` fence whose closing fence is at end-of-output. The extracted single balanced object still passes the unchanged schema and semantic checks. Extra objects, non-JSON fences, truncated output, and text after the closing fence remain invalid on the first attempt. The separate automatic format-repair path may remove only that framing: host validation independently extracts complete balanced objects from the original text, requires exactly one of them to already pass the full ReviewReport contract, and compares the normalized retry for exact equality.

Stored raw output is valid UTF-8 capped at 64 KiB including the truncation marker. Raw output and errors are retained in the audit but are not copied into live progress snapshots.

The merged report records:

- explicit, inferred, or interactive preflight selection;
- branch, remote, attempted/successful fetches, fetch state, ahead/behind, and input size;
- target and frozen-input fingerprints plus limited-context markers;
- requested independent routes, backend/fallback reason, concurrency, waves, route-session policy, format-repair count, and effective limits;
- each reviewer/refuter terminal status, usage, duration, `turnLimited`, optional persisted-session path, parsed result, raw output, or error;
- original/retry terminal audit data and optional session paths for every attempted format repair, including failed repairs;
- blocking, advisory, and contested evidence;
- `candidate-approve`, `needs-adjudication`, `inconclusive`, `stale`, `cancelled`, or `failed` overall state.

No state means final approval. `candidate-approve` only means that no blocking cluster met the configured deterministic gate.

## Durable audit and adjudication handoff

TUI dispatch, result, cancellation, and operational-failure boundaries are retained as non-model-context session entries and rendered through custom entry renderers. Report and dispatch nodes include an expansion hint; non-success report summaries expose bounded route errors before expansion. Every non-TUI completed report or error is also written atomically with private permissions under:

```text
$PI_CODING_AGENT_DIR/extension-data/pi-adversarial-review/audit/
```

The default is `~/.pi/agent/extension-data/pi-adversarial-review/audit/`. This standalone store is independent of Pi's session flush policy and rejects extension-owned symlink traversal.

A confirmed cancellation before freeze completes produces a versioned minimal audit only when the freeze rejects with the exact run-signal abort reason and temporary-workspace cleanup succeeds. It contains preflight target, requested reviewer/refuter metadata, gating, and timestamps; it never invents frozen hashes or route results. Concurrent input failures and cleanup failures remain errors. Pre-freeze cancellation is persisted in every mode and retained as an `adversarial-review-cancellation` session entry.

Pi guards extension stdout in headless modes. Scripts should use process status, not an assumed stdout/stderr split, to distinguish a completed report from an operational failure. Print/JSON failures emit a control-safe stderr diagnostic, persist an error audit, and set non-zero process status. RPC keeps the host alive and exposes `adversarial-review-dispatch`, `adversarial-review-result`, `adversarial-review-error`, and `adversarial-review-cancellation` through `get_entries`; the hidden `adversarial-review-report` custom message carries only the main-model handoff.

Print mode emits the merged report without starting a model turn. Non-cancelled successful non-print modes send a fixed evidence-first follow-up to the current main model; cancelled reports remain persisted without `triggerTurn`. Repository and model text is encoded as untrusted data. If the handoff exceeds 128 KiB, the audit is preserved but delivery fails loud rather than silently truncating findings.

The main model must inspect actual code for every blocking finding, mark it valid or invalid with concrete evidence, ask before choosing product/design trade-offs, and must not edit, fix, commit, or claim final approval automatically.

## Security hardening

Reviewer/refuter sessions expose only `read`, `grep`, `find`, and `ls`; format-repair sessions expose no tools at all. Tool restriction is not an OS sandbox. The package is intended for trusted local repositories while treating repository and model text as untrusted review input.

Automatic fetch uses a non-shell process group with timeout, cancellation, bounded output, and terminal cleanup. Repository/environment SSH commands, askpass and credential helpers, unapproved transports, remote VCS/upload-pack overrides, hooks, clean/process filters, recursive submodule fetch, and maintenance tasks are disabled. Raw fetch stderr that may contain credentials is never reported.

Frozen patch capture uses raw Git output, ignores replace refs, and disables configured textconv and content filters. Git subprocesses neutralize inherited `GIT_DIR`, `GIT_WORK_TREE`, index/common/object/alternate-object paths, dynamic config parameters, replace-ref base, and namespace. Review never invokes broad `git worktree prune`.

## Range capacity and crash recovery

Before registering a detached range worktree, Review measures B's complete recursive tree. Preliminary hard limits are 100,000 entries and 2 GiB of raw logical blob data.

The checkout filesystem must initially retain an additive reserve of 512 MiB plus twice the raw tree bytes. Worktree administration and index data require another deterministic 16 MiB plus 256 bytes per tree entry. If temporary and common-Git paths share a filesystem, reserves are combined against one available pool; otherwise each filesystem is checked separately. Capacity failures report measured, allowed, available, and required values before `git worktree add`; there is no override flag.

Creation persists a versioned PID lease and transitions through `workspace → pending → owned`. It then runs token-locked `git worktree add --detach --no-checkout` followed by a hardened non-recursive reset. Hooks, clean/smudge/process drivers, LFS smudge, fsmonitor, untracked cache, replace refs, recursive submodules, optional locks, inherited Git context, CRLF conversion, and live symlinks are disabled. Committed symlinks become ordinary target-text files. Because raw blob size can underestimate built-in checkout expansion, reset continuously enforces a 512 MiB free-space floor, waits for in-flight measurements, and performs a final measurement after Git exits successfully.

Normal cleanup is worktree-first and transitions through `registration-removing → completed`: prove the exact token-owned checkout and admin marker, durably record removal intent, remove only that locked registration, persist completion, then delete the private run directory. Verification or removal failure retains recoverable state instead of deleting uncertain metadata.

A same-UID 24-hour scavenger skips its own current working directory and live owner PIDs. For stale runs it atomically quarantines the run, then moves only the exact proven admin entry from `.git/worktrees` into a token-derived private directory on the same common-Git filesystem. It revalidates device/inode, marker, lock token, checkout identity, and substitution protection immediately before deletion. Missing or mismatched proof, path substitution, malformed state, collisions, and user worktrees are preserved; broad prune is never used.

## Compatibility and backend fallback

| Component | Requirement |
|---|---|
| Pi | `>=0.84.0 <1` with `ctx.scopedModels` and custom message renderers |
| Subagents | Optional protocol `3`, `maxConcurrent >= 1` for the external backend and FleetView |
| Node.js | `>=22.19.0` |

An absent external extension selects embedded Review silently. An older, malformed, or incompatible responder is ignored with a warning and recorded fallback reason. Missing explicit model scope fails before spawn.

Embedded stop and disposal wait for real terminal settlement and are bounded by a Review-only 30-second deadline. Missing that deadline fails cleanup and retains frozen input and any detached worktree; an abort acknowledgement is never treated as terminal.

Backend selection happens once per run. After a compatible external backend is selected, its failures remain on that backend and are not retried through embedded execution.

## Rollback

Cancel or wait for the active run, then wait for its status to clear before removing the package:

```bash
pi remove npm:@zhcsyncer/pi-adversarial-review
```

Keep a separately installed `@zhcsyncer/pi-subagents` package if other workflows use it. Removal does not modify the repository or delete existing session/audit entries. The root `@zhcsyncer/pi-extensions` package needs no rollback because it does not include Review.

## Development

```bash
pnpm --filter @zhcsyncer/pi-adversarial-review check
```
