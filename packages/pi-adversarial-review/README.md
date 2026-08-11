# @zhcsyncer/pi-adversarial-review

[简体中文](./README.zh-CN.md)

Deterministic multi-model adversarial code review orchestration for Pi.

## Status

The no-UI core, quality calibration, scoped-model picker, independent refutation, and main-model adjudication handoff are complete. The extension is standalone: it uses an installed protocol-v3 Subagents extension when available, otherwise it runs the same caller-owned execution core through an embedded backend. It is published independently and is not loaded by the root `@zhcsyncer/pi-extensions` bundle.

## Usage

Install the review extension and scope the models that may participate:

```bash
pi install npm:@zhcsyncer/pi-adversarial-review
```

Installing `@zhcsyncer/pi-subagents` separately is optional. A compatible protocol-v3 extension adds shared queueing and per-route FleetView visibility; without it, the review command automatically uses its embedded backend and does not register Agent tools, commands, schedulers, or Subagents UI.

In TUI mode, omit reviewer flags to open the searchable picker:

```text
/adversarial-review
```

A Git preflight runs before the reviewer picker. Without an explicit target, it fetches the current branch's upstream remote first, then falls back to `origin`, then to a sole remote, and detects the remote default branch from remote HEAD, `main`, or `master`. If remote HEAD is absent and both `main` and `master` exist, TUI asks which one is the base instead of guessing. A normal feature branch reviews committed changes from the remote default branch plus staged, unstaged, and untracked work; a synchronized default branch reviews local work only. Local commits or divergence on the default branch, detached HEAD, an in-progress Git operation, unmerged files, and ambiguous remote/default-branch state require a TUI decision instead of silently starting. Headless modes require an explicit target for those states.

If fetch fails, TUI offers Retry, use the existing local remote-tracking ref, or Cancel; Escape also cancels an in-flight preflight/fetch, while headless modes fail loud. Preflight never merges, rebases, resets, checks out, or prunes. The chosen target, branch, ahead/behind counts, and fetch status are shown before execution. HEAD, branch, exact status, selected ref SHAs, and the frozen patch hash are revalidated after model selection and against the frozen input; a change reruns TUI preflight or fails before any reviewer spawn.

Each scoped model cycles between `disabled` and its supported thinking levels. A scope-pinned model can only use `disabled` or the pinned level. Confirm 2–8 routes with **Run selected reviewers**; Escape cancels before any reviewer starts. Valid selections are remembered only for the current Pi session and removed scope entries are not restored.

Add `--refute` to independently challenge each blocking cluster. TUI opens a second single-route picker; non-interactive modes require an exact `--refuter`:

```text
/adversarial-review --refute

/adversarial-review \
  --reviewer provider-a/model-a@high \
  --reviewer provider-b/model-b@xhigh \
  --refute \
  --refuter provider-c/model-c@high
```

The refuter runs in a fresh isolated session for each blocking cluster. `refuted=true` adds a contested record but never removes or downgrades the blocking finding; false, failed, timed-out, and invalid results also leave it intact.

For reproducible review-only runs, or in RPC/JSON/print modes, pass at least two exact reviewer routes:

```text
/adversarial-review \
  --base origin/main \
  --reviewer provider-a/model-a@high \
  --reviewer provider-b/model-b@xhigh
```

Explicit targets are `--local`, `--base <ref>`, or `--range <refA>..<refB>`; they override inference. `--local` is an explicit local/offline mode and skips fetch. `--base` and `--range` refresh any referenced remote-tracking remotes first. A range is committed-only: the current worktree must be on a named branch, and ref B must be an ancestor of that branch's current HEAD. Detached HEAD and divergent or unrelated B are rejected before model selection. Every range, including a clean B=current-HEAD range, gives all reviewer and refuter routes one extension-owned detached linked worktree at exactly B under the private run directory. The live repository root is never reused, and its branch, HEAD, index, tracked files, and untracked files are not moved or rewritten. Optional arguments include `--reqdoc <path>`, `--focus <text>`, `--gating weighted|strict`, and the explicit large-target acknowledgement `--allow-large`. The command fails closed when no explicit model scope is configured. During the freeze/reviewer/refuter stage of a TUI run, the footer shows aggregate progress and Escape opens a confirmation UI without stopping work. **Continue review** is selected by default; only moving to **Confirm cancellation** and pressing Enter aborts through the shared run-level signal, after which the command waits for Git processes and temporary-workspace cleanup before the status clears. Enter on the default choice or Escape from confirmation returns to the same running loader without restarting work. Git preflight and reviewer/refuter pickers keep their immediate Escape behavior, while session shutdown bypasses confirmation and still waits for cleanup. Per-route FleetView detail is available when a compatible external Subagents runtime is selected; embedded runs retain the same route detail in the audit report.

The recommended whole-target threshold is 200 KiB or 5,000 logical lines. This is a review-quality and resource signal, not a Git limit: the same patch and attached context are sent to two to eight isolated reviewers, so a large target both dilutes evidence and multiplies context use, latency, memory, and provider cost. Byte and line measurements remain deterministic across providers, unlike tokenizer-specific estimates. Above the recommendation, TUI asks whether to review the whole target or show smaller ranges; headless modes require `--allow-large`. An approved large target raises reviewer turns from 25 to 40 and refuter turns from 12 to 20, while configured grace turns (five by default) and wall-clock timeouts still bound runaway work. Ordinary targets use reviewer 10 minutes per route / 20 minutes overall and refuter 5 / 15 minutes; approved large targets use reviewer 20 / 30 minutes and refuter 10 / 30 minutes. The absolute fail-loud limit is 1 MiB or 25,000 lines.

When range guidance is requested—or the absolute limit is exceeded—the diagnostic reports only measured dimensions that are actually over the relevant limit and suggests SHA-bound, non-empty `--range` target replacements whose complete frozen bundles fit the 200 KiB / 5,000-line recommendation. Keep every other original option and run each range separately. Base-target suggestions cover committed changes only, so uncommitted changes still require a separate `--local` review. If a single-commit range remains too large, reduce attached context or split that commit.

## Output

Each reviewer and refuter attempt is retained, including provider errors, timeouts, cancellation, and invalid JSON. Reviewers are instructed to return bare JSON whose first and last non-whitespace characters are `{` and `}`. As a narrow provider-robustness fallback, the reviewer parser also accepts leading prose followed by exactly one `json` fence ending at end-of-output; the extracted single balanced object still passes the unchanged schema and semantic checks, and extra objects, non-JSON fences, truncated output, or text after the closing fence remain invalid. Stored raw output is valid UTF-8 capped at 64 KiB including its truncation marker. The report also records whether Git preflight was explicit, inferred, or interactive; its branch, selected remote, attempted versus successfully fetched remotes, fetch state, ahead/behind counts, frozen input size, and large-target approval; plus the selected runtime backend, fallback reason, requested routes, concurrency, execution waves, effective reviewer/refuter turn and wall-clock limits, per-route `turnLimited` wrap-up markers, and contested evidence. Conservative clustering prioritizes never merging distinct issues into false consensus; if multiple reviewers raise unclustered advisories, the run still requires adjudication. The deterministic gate produces `candidate-approve`, `needs-adjudication`, `inconclusive`, `stale`, `cancelled`, or `failed`; it never claims final approval.

Print mode emits the merged report without starting a model turn. A confirmed cancellation before frozen input is complete records a versioned, minimal audit only when the freeze rejects with that run signal's exact abort reason and temporary-workspace cleanup succeeds; concurrent input failures and cleanup failures remain errors. The audit contains the preflight target, requested reviewer routes, refuter request/route metadata, and timestamps; it does not invent frozen-input hashes or route results, and no reviewer or refuter is spawned. This cancellation is stored as a private standalone audit in every mode and retained as an `adversarial-review-cancellation` session entry. Every non-TUI completed report or error is likewise written atomically under `$PI_CODING_AGENT_DIR/extension-data/pi-adversarial-review/audit/` (by default `~/.pi/agent/extension-data/pi-adversarial-review/audit/`), independently of Pi's session flush policy. Pi guards extension stdout in headless modes, so scripts should use the process status—not a stdout/stderr split—to distinguish a completed report from an operational failure. Print/JSON failures write a control-safe diagnostic to stderr, persist an error audit entry, and set a non-zero process status; RPC mode retains the error entry without terminating the long-lived host. RPC clients can retrieve `adversarial-review-report`, `adversarial-review-error`, and `adversarial-review-cancellation` custom entries through `get_entries`. Other successful non-print modes persist the full audit report and send a fixed follow-up to the current main model. Repository/model text is encoded as untrusted data; if the handoff exceeds 128 KiB, the audit is preserved but the model turn fails loud instead of silently truncating findings. The main model must inspect actual code, mark every blocking finding valid or invalid with evidence, ask before resolving design trade-offs, and must not edit, fix, or commit automatically.

## Safety

Reviewers and refuters do not inherit the parent conversation and receive only `read`, `grep`, `find`, and `ls`. They cannot edit, fix, or commit. Automatic fetch uses a non-shell process group with timeout, cancellation, bounded output, and terminal cleanup. Repository/environment SSH commands, askpass and credential helpers, unapproved transports, remote VCS/upload-pack overrides, hooks and clean/process filters, recursive submodule fetch, and maintenance tasks are disabled; raw fetch stderr that may contain credentials is never reported. Frozen patch capture remains raw Git output, ignores replace refs, never runs configured textconv or content filters, and reports binary, LFS, and submodule limitations explicitly.

Before a detached range worktree is registered, the extension measures B's full recursive tree. The fixed preliminary limits are 100,000 entries and 2 GiB of raw logical blob data. The checkout filesystem must initially retain an additive reserve of 512 MiB plus twice those raw bytes, and worktree administration and index data require another deterministic 16 MiB plus 256 bytes per tree entry. When the temporary and common Git paths share a filesystem these reserves are added against that one available pool; otherwise each filesystem is checked separately. Capacity failures report measured, allowed, available, and required values before `git worktree add`; there is no picker, override, or CLI flag. Creation transitions the run's atomic workspace lease to pending ownership, then uses `git worktree add --detach --no-checkout --lock --reason pi-adversarial-review:<random-token>` followed by a hardened non-recursive reset. Repository hooks, configured clean/smudge/process drivers, LFS smudge, fsmonitor, untracked cache, replace refs, recursive submodules, optional locks, and inherited Git directory/index/config-parameter/alternate-object environment are disabled; `core.autocrlf=false`, `core.eol=lf`, and `core.symlinks=false` make checkout behavior narrower and committed symlinks ordinary target-text files. Raw blob size can still underestimate `ident`, working-tree-encoding, or other built-in checkout expansion, so reset continuously enforces the 512 MiB live free-space floor, waits for any in-flight measurement, and performs a final measurement after Git exits successfully. The frozen raw patch remains the authoritative review evidence.

Every private run directory immediately receives a versioned workspace manifest with its owner PID, so local and base reviews receive the same live-process protection as ranges. Range creation transitions that manifest from workspace to pending to owned. Normal cleanup is worktree-first: prove the exact token-owned checkout, durably enter registration-removal state, remove its locked registration, persist completed state, then delete the private run directory. A worktree removal or verification failure is classified separately and retains recoverable ownership state; if admin-quarantine or final run-directory deletion fails, retry or TTL cleanup resumes from the durable removal/completed state. The pre-add pending state records the random token, owner PID, exact paths, common Git directory, and target SHA; the race-free add lock reason proves ownership until the same token is written into the exact admin directory and the manifest becomes owned. The same-UID 24-hour scavenger excludes its current working directory and live owner PIDs, atomically quarantines a stale run, then atomically moves the exact proven admin entry out of the public `.git/worktrees` namespace into a token-derived private directory on the same common-Git filesystem. It immediately revalidates device/inode, marker, lock token, checkout path identity, and substitution protection before deleting only that private admin; mismatch is restored when possible and otherwise preserved. Missing or mismatched proof, path substitution, malformed state, collisions, and user worktrees are preserved, and broad `git worktree prune` is never used. Tool restriction is not an operating-system sandbox; repository content remains untrusted input.

## Compatibility

| Component | Requirement |
|---|---|
| Pi | `>=0.84.0 <1` with `ctx.scopedModels` and custom message renderers |
| Subagents | Optional. Protocol `3` with `maxConcurrent >= 1` enables the external backend and FleetView |
| Node.js | `>=22.19.0` |

An absent external Subagents extension selects the embedded backend silently. Embedded Review stop and disposal wait for real terminal settlement but are bounded by a Review-only 30-second deadline; a missed deadline fails cleanup and retains frozen input and any detached review worktree rather than treating an abort acknowledgement as terminal. An older, malformed, or incompatible responder is ignored with a warning and recorded fallback reason. Once a compatible external backend is selected, failures remain on that backend and are never retried through embedded execution. Missing explicit model scope still fails before spawning.

## Rollback

Press Escape and wait for the run status to clear, then remove only this standalone extension:

```bash
pi remove npm:@zhcsyncer/pi-adversarial-review
```

Keep any separately installed `@zhcsyncer/pi-subagents` extension if other workflows use it; the runtime code dependency installed with this package is removed with the package itself. Removing the extension does not modify the repository or delete existing session audit entries. This package is not part of the root bundle, so root `@zhcsyncer/pi-extensions` installations need no rollback.

## Development

```bash
pnpm --filter @zhcsyncer/pi-adversarial-review check
```
