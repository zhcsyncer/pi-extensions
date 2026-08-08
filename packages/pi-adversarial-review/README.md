# @zhcsyncer/pi-adversarial-review

[简体中文](./README.zh-CN.md)

Deterministic multi-model adversarial code review orchestration for Pi.

## Status

The Phase 1 no-UI core is complete. It uses explicit reviewer routes and the in-process protocol-v3 contract from `@zhcsyncer/pi-subagents`. The package is published independently and is not loaded by the root `@zhcsyncer/pi-extensions` bundle. Model picker, refutation, and automatic main-model adjudication remain later phases.

## Usage

Install/load both standalone extensions, scope the models that may participate, then invoke the command with at least two exact routes:

```bash
pi install npm:@zhcsyncer/pi-subagents
pi install npm:@zhcsyncer/pi-adversarial-review
```

```text
/adversarial-review \
  --reviewer provider-a/model-a@high \
  --reviewer provider-b/model-b@xhigh
```

Supported targets are the current local changes, `--base <ref>`, or `--range <refA>..<refB>`. Optional arguments include `--reqdoc <path>`, `--focus <text>`, and `--gating weighted|strict`. The core fails closed when no explicit model scope is configured.

## Output

Each reviewer is retained as a route result, including provider errors, timeouts, cancellation, and invalid JSON. Conservative clustering prioritizes never merging distinct issues into false consensus; if multiple reviewers raise unclustered advisories, the run still requires adjudication. The deterministic gate produces `candidate-approve`, `needs-adjudication`, `inconclusive`, `stale`, `cancelled`, or `failed`; it never claims final approval. Print mode writes the merged report directly. Other modes persist an audit entry and queue the report for the next user turn without waking the main model automatically.

## Safety

Reviewers do not inherit the parent conversation and receive only `read`, `grep`, `find`, and `ls`. They cannot edit, fix, or commit. Tool restriction is not an operating-system sandbox; repository content remains untrusted input.

## Development

```bash
pnpm --filter @zhcsyncer/pi-adversarial-review check
```
