# @zhcsyncer/pi-adversarial-review

[简体中文](./README.zh-CN.md)

Deterministic multi-model adversarial code review orchestration for Pi.

## Status

The no-UI core, quality calibration, scoped-model picker, independent refutation, and main-model adjudication handoff are complete. The extension uses the in-process protocol-v3 contract from `@zhcsyncer/pi-subagents`. It is published independently and is not loaded by the root `@zhcsyncer/pi-extensions` bundle.

## Usage

Install/load both standalone extensions and scope the models that may participate:

```bash
pi install npm:@zhcsyncer/pi-subagents
pi install npm:@zhcsyncer/pi-adversarial-review
```

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

Supported targets are the current local changes, `--base <ref>`, or `--range <refA>..<refB>`. Optional arguments include `--reqdoc <path>`, `--focus <text>`, and `--gating weighted|strict`. The command fails closed when no explicit model scope is configured. During a TUI run, the footer shows aggregate progress, Subagents FleetView retains per-route detail, and Escape cancels the whole fleet through the same stop path.

## Output

Each reviewer and refuter attempt is retained, including provider errors, timeouts, cancellation, and invalid JSON. The report also records requested routes, runtime concurrency, execution waves, and contested evidence. Conservative clustering prioritizes never merging distinct issues into false consensus; if multiple reviewers raise unclustered advisories, the run still requires adjudication. The deterministic gate produces `candidate-approve`, `needs-adjudication`, `inconclusive`, `stale`, `cancelled`, or `failed`; it never claims final approval.

Print mode writes the merged report directly and does not start a model turn. Other modes persist the full audit report and send a fixed follow-up to the current main model. Repository/model text is encoded as untrusted data; if the handoff exceeds 128 KiB, the audit is preserved but the model turn fails loud instead of silently truncating findings. The main model must inspect actual code, mark every blocking finding valid or invalid with evidence, ask before resolving design trade-offs, and must not edit, fix, or commit automatically.

## Safety

Reviewers and refuters do not inherit the parent conversation and receive only `read`, `grep`, `find`, and `ls`. They cannot edit, fix, or commit. Tool restriction is not an operating-system sandbox; repository content remains untrusted input.

## Development

```bash
pnpm --filter @zhcsyncer/pi-adversarial-review check
```
