# @zhcsyncer/pi-adversarial-review

[简体中文](./README.zh-CN.md)

Deterministic multi-model adversarial code review orchestration for Pi.

## Status

The no-UI core, quality calibration, and scoped-model picker are complete. The extension uses the in-process protocol-v3 contract from `@zhcsyncer/pi-subagents`. It is published independently and is not loaded by the root `@zhcsyncer/pi-extensions` bundle. Refutation and automatic main-model adjudication remain later phases.

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

For reproducible runs, or in RPC/JSON/print modes, pass at least two exact routes:

```text
/adversarial-review \
  --reviewer provider-a/model-a@high \
  --reviewer provider-b/model-b@xhigh
```

Supported targets are the current local changes, `--base <ref>`, or `--range <refA>..<refB>`. Optional arguments include `--reqdoc <path>`, `--focus <text>`, and `--gating weighted|strict`. The command fails closed when no explicit model scope is configured. During a TUI run, the footer shows aggregate progress, Subagents FleetView retains per-route detail, and Escape cancels the whole fleet through the same stop path.

## Output

Each reviewer is retained as a route result, including provider errors, timeouts, cancellation, and invalid JSON. The report also records requested routes, runtime concurrency, and execution waves. Conservative clustering prioritizes never merging distinct issues into false consensus; if multiple reviewers raise unclustered advisories, the run still requires adjudication. The deterministic gate produces `candidate-approve`, `needs-adjudication`, `inconclusive`, `stale`, `cancelled`, or `failed`; it never claims final approval. Print mode writes the merged report directly. Other modes persist an audit entry and queue the report for the next user turn without waking the main model automatically.

## Safety

Reviewers do not inherit the parent conversation and receive only `read`, `grep`, `find`, and `ls`. They cannot edit, fix, or commit. Tool restriction is not an operating-system sandbox; repository content remains untrusted input.

## Development

```bash
pnpm --filter @zhcsyncer/pi-adversarial-review check
```
