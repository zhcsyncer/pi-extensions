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
  --reviewer provider-a/model-a@high \
  --reviewer provider-b/model-b@xhigh
```

Supported targets are the current local changes, `--base <ref>`, or `--range <refA>..<refB>`. Optional arguments include `--reqdoc <path>`, `--focus <text>`, and `--gating weighted|strict`. The command fails closed when no explicit model scope is configured. During a TUI run, the footer shows aggregate progress and Escape cancels the whole fleet through the same stop path. Per-route FleetView detail is available when a compatible external Subagents runtime is selected; embedded runs retain the same route detail in the audit report.

## Output

Each reviewer and refuter attempt is retained, including provider errors, timeouts, cancellation, and invalid JSON. Stored raw output is valid UTF-8 capped at 64 KiB including its truncation marker. The report also records the selected runtime backend, fallback reason, requested routes, concurrency, execution waves, and contested evidence. Conservative clustering prioritizes never merging distinct issues into false consensus; if multiple reviewers raise unclustered advisories, the run still requires adjudication. The deterministic gate produces `candidate-approve`, `needs-adjudication`, `inconclusive`, `stale`, `cancelled`, or `failed`; it never claims final approval.

Print mode emits the merged report without starting a model turn. Pi guards extension stdout in headless modes, so scripts should use the process status—not a stdout/stderr split—to distinguish a completed report from an operational failure. Print/JSON failures write a control-safe diagnostic to stderr, persist an error audit entry, and set a non-zero process status; RPC mode retains the error entry without terminating the long-lived host. RPC clients can retrieve both `adversarial-review-report` and `adversarial-review-error` custom entries through `get_entries`. Other successful non-print modes persist the full audit report and send a fixed follow-up to the current main model. Repository/model text is encoded as untrusted data; if the handoff exceeds 128 KiB, the audit is preserved but the model turn fails loud instead of silently truncating findings. The main model must inspect actual code, mark every blocking finding valid or invalid with evidence, ask before resolving design trade-offs, and must not edit, fix, or commit automatically.

## Safety

Reviewers and refuters do not inherit the parent conversation and receive only `read`, `grep`, `find`, and `ls`. They cannot edit, fix, or commit. Range snapshots stream committed raw blobs, ignore replace refs, and freezing never executes configured textconv, clean/smudge/process filters, or fsmonitor; binary, LFS, and submodule limits are reported explicitly. Temporary workspaces are mode-restricted, normally removed in `finally`, and same-UID non-symlink crash remnants older than 24 hours are atomically quarantined before scavenging on the next run. Tool restriction is not an operating-system sandbox; repository content remains untrusted input.

## Compatibility

| Component | Requirement |
|---|---|
| Pi | `>=0.84.0 <1` with `ctx.scopedModels` and custom message renderers |
| Subagents | Optional. Protocol `3` with `maxConcurrent >= 1` enables the external backend and FleetView |
| Node.js | `>=22.19.0` |

An absent external Subagents extension selects the embedded backend silently. An older, malformed, or incompatible responder is ignored with a warning and recorded fallback reason. Once a compatible external backend is selected, failures remain on that backend and are never retried through embedded execution. Missing explicit model scope still fails before spawning.

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
