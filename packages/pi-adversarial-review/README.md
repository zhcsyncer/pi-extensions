# @zhcsyncer/pi-adversarial-review

[简体中文](./README.zh-CN.md) · [Full reference](./REFERENCE.md)

Deterministic multi-model adversarial code review orchestration for Pi.

## Status

The extension provides Git-aware input freezing, two-to-eight isolated reviewer routes, conservative finding convergence, optional independent Refute, main-model adjudication handoff, and durable audit output. It uses a compatible installed protocol-v3 Subagents extension when available and otherwise selects the same caller-owned execution core through an embedded backend.

This package is published independently and is not loaded by the root `@zhcsyncer/pi-extensions` bundle.

## Install

```bash
pi install npm:@zhcsyncer/pi-adversarial-review
```

Installing `@zhcsyncer/pi-subagents` separately is optional. A compatible external runtime adds shared queueing and FleetView drill-down; without it, Review runs through the embedded backend and does not register Subagents tools, commands, schedulers, or UI.

Scope the models that Review may use with Pi's `/scoped-models` command before starting a run.

## Quick start

In TUI mode, open the setup picker:

```text
/adversarial-review
```

Choose 2–8 exact reviewer model/thinking routes. Unremembered routes start disabled and first enable at `medium`, or at the nearest supported level. Refute is enabled by default with a fresh session on the current main model and exact thinking level; it can be changed to a scoped model or disabled.

Before model selection, Git preflight fetches and identifies the safest target it can prove. A normal feature branch reviews committed changes from the remote default branch plus staged, unstaged, and untracked work. A synchronized default branch reviews local work only. Ambiguous or risky states require an explicit TUI decision rather than a guess. If that inferred feature-branch target is large, ordinary `/adversarial-review` offers the same continuous start-to-HEAD commit line instead of an automatic batch plan.

To open that commit line directly without writing refs or hashes, use:

```text
/adversarial-review --range
```

The endpoint is fixed at the captured `HEAD`. Every visible first-parent commit is a possible start: each row says `Start <sha> · reviews N commits`, so you can choose 3, 6, or any other available continuous count. The selected start commit is included and the complete start-to-HEAD range is reviewed together in one run. On a feature branch, choices normally stop at its freshly fetched default-branch merge-base. Above the recommendation, TUI can review the whole selected range after confirmation or return to the same commit line for a closer start; above the hard limit it must choose a closer start.

For a reproducible or headless run, provide the target and at least two exact reviewer routes:

```text
/adversarial-review \
  --base origin/main \
  --reviewer provider-a/model-a@high \
  --reviewer provider-b/model-b@xhigh
```

Headless Refute also requires an exact refuter route:

```text
/adversarial-review \
  --range HEAD~3..HEAD \
  --reviewer provider-a/model-a@high \
  --reviewer provider-b/model-b@high \
  --refute \
  --refuter provider-c/model-c@medium
```

Target forms are:

- `--local` — staged, unstaged, and untracked local work; skips fetch and never includes commits.
- `--base <ref>` — committed changes from the merge base through HEAD, plus local work.
- `--range` — TUI-only commit-line picker: endpoint fixed at captured `HEAD`, choose any earliest included commit.
- `--range <A>..<B>` — exact committed-only range reviewed from an extension-owned detached worktree at B. For example, use `--range HEAD~5..HEAD` for the latest five commits.

See the [command reference](./REFERENCE.md#command-options) for requirements, focus/requirement inputs, gating, and large-target handling.

## How a run works

1. **Preflight** proves the Git target and records its branch/ref/fetch decision.
2. **Freeze** captures one deterministic bounded input; every route reads the same evidence.
3. **Review** runs isolated read-only agents. Every reviewer receives the same trusted charter, frozen evidence, and complete assignment, then independently performs a full adversarial review.
4. **Converge** validates JSON, conservatively clusters independently produced findings, and applies `weighted` or `strict` gating.
5. **Refute** optionally gives each blocking cluster to a fresh isolated session. Counter-evidence can mark a finding contested but never delete or downgrade it.
6. **Adjudicate** persists a non-cancelled report and asks the current main model/user to verify blocking findings against actual code. The extension never claims final approval.

Severity measures impact, confidence measures evidence strength, and votes measure independent corroboration. Under weighted gating, a cluster is blocking at the reviewer quorum, or when one original finding itself is `critical`/`high` with confidence at least `0.85`; ratings from different findings are never spliced together.

## TUI visibility and tool surface

`/adversarial-review` is a slash command, not a tool call made by the main model. Merely installing or loading the extension adds no Agent tool to the main session.

During a run:

- one temporary card above the editor owns the compact phase/count/elapsed summary, a one-line `Snapshot → Review → Gate → Finish` stepper, the target, frozen input size, deterministic gate/Refute outcomes, and real cleanup progress; Refute is inserted only if it actually starts, and the stepper never claims a percentage;
- the extension does not occupy Pi's footer status area;
- with a compatible external Subagents runtime, its Agents/FleetView surface exclusively owns per-agent model, execution, conversation, and tool-call detail; the Review card does not repeat those rows;
- the embedded fallback has no FleetView, so the Review card retains bounded per-agent status there;
- a durable, non-model-context transcript node records the exact frozen target and requested routes immediately before reviewer dispatch;
- the final report is a separate durable transcript node. Its compact failure view exposes route errors immediately, and its expanded view includes every route outcome and complete blocking/advisory finding details.

Reviewer and refuter sessions do not inherit the parent conversation. Their inline agent configuration disables extensions and skills and exposes only `read`, `grep`, `find`, and `ls`. Those low-level calls are intentionally not duplicated in the Review status card.

Escape during freeze/review/refute opens a confirmation UI while work continues. **Continue review** is selected by default; only **Confirm cancellation** aborts the run. The card remains until runtime termination and frozen-workspace cleanup have actually completed, then it is removed. Preflight and picker Escape remain immediate cancellation actions.

## Result semantics

A run ends as one of:

- `candidate-approve` — no blocking cluster passed the configured gate;
- `needs-adjudication` — blocking or quorum-level advisory evidence needs a final decision;
- `inconclusive` — too few valid reviewers completed;
- `stale`, `cancelled`, or `failed` — not eligible for approval.

`refuted=true` means the refuter supplied a supported challenge. It creates a `contested` record; the blocking finding remains until the main model or user decides it against the code. A cancelled partial report is retained for audit but never triggers an automatic main-model turn.

Reports retain every independent route outcome, validated findings, failed/invalid attempts, runtime backend, gate inputs, Refute results, and target fingerprints. Non-TUI runs also write private standalone audits under `$PI_CODING_AGENT_DIR/extension-data/pi-adversarial-review/audit/` (default `~/.pi/agent/extension-data/pi-adversarial-review/audit/`).

## Safety boundary

Reviewer/refuter tool restriction is defense in depth, not an operating-system sandbox. Repository content remains untrusted input.

The extension never edits, fixes, or commits code. It does not merge, rebase, reset, prune, or switch the user's real worktree. Range reviews use a token-owned detached linked worktree and fail closed on unproven ownership, capacity, cleanup, or Git-state changes. Fetch and checkout disable repository-controlled hooks, helpers, filters, recursive submodules, replace refs, and inherited Git repository context.

The recommended whole-target limit is 200 KiB or 5,000 logical lines; the hard limit is 1 MiB or 25,000 lines. Bare `--range` keeps the selected continuous start-to-HEAD history intact: above the recommendation, confirm the whole range or choose a closer start; above the hard limit, choose a closer start or cancel. It never silently replaces that selection with automatic batches. Explicit large `--base` or `--range A..B` targets retain deterministic commit-plan diagnostics for users who intentionally want separate runs. Full SHAs remain the exact identities behind all human-readable labels. Headless modes require an explicit `--range` or `--allow-large`.

## Compatibility

| Component | Requirement |
|---|---|
| Pi | `>=0.84.0 <1` with `ctx.scopedModels` and custom message renderers |
| Subagents | Optional; protocol `3` with `maxConcurrent >= 1` enables the external backend and FleetView |
| Node.js | `>=22.19.0` |

An unavailable or incompatible external runtime falls back before execution to embedded Review with a recorded reason. Once a backend is selected for a run, failures are not retried through another backend.

## Reference

The [full reference](./REFERENCE.md) covers:

- Git inference, fetch failure handling, and revalidation;
- every command option and headless requirement;
- reviewer charter, rating rubric, clustering, gating, and Refute;
- TUI lifecycle and the internal spawn/tool-call shape;
- limits, timeouts, parsers, audits, and adjudication handoff;
- fetch hardening, range capacity gates, worktree ownership, cleanup, and crash recovery.

## Rollback

Wait for the run status to clear, then remove only this standalone extension:

```bash
pi remove npm:@zhcsyncer/pi-adversarial-review
```

Keep a separately installed `@zhcsyncer/pi-subagents` package if other workflows use it. Removing Review does not modify the repository or delete existing session/audit entries.

## Development

```bash
pnpm --filter @zhcsyncer/pi-adversarial-review check
```
