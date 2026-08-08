# @zhcsyncer/pi-adversarial-review

[简体中文](./README.zh-CN.md)

Deterministic multi-model adversarial code review orchestration for Pi.

## Status

The package is under active development. Its no-UI core uses explicit reviewer routes and the in-process protocol-v3 contract from `@zhcsyncer/pi-subagents`. It is published independently and is not loaded by the root `@zhcsyncer/pi-extensions` bundle.

## Usage

Load both standalone extensions, scope the models that may participate, then invoke the command with at least two exact routes:

```text
/adversarial-review \
  --reviewer provider-a/model-a@high \
  --reviewer provider-b/model-b@xhigh
```

Supported targets are the current local changes, `--base <ref>`, or `--range <refA>..<refB>`. The core fails closed when no explicit model scope is configured. Phase 1 does not open a picker or automatically wake the main model after producing the merged report.

## Safety

Reviewers do not inherit the parent conversation and receive only `read`, `grep`, `find`, and `ls`. They cannot edit, fix, or commit. Tool restriction is not an operating-system sandbox; repository content remains untrusted input.

## Development

```bash
pnpm --filter @zhcsyncer/pi-adversarial-review check
```
