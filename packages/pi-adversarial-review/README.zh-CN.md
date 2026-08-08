# @zhcsyncer/pi-adversarial-review

[English](./README.md)

面向 Pi 的确定性多模型对抗式代码评审编排扩展。

## 状态

本包正在开发中。无 UI 核心使用显式 reviewer route，并依赖 `@zhcsyncer/pi-subagents` 的进程内 protocol-v3 契约。本包独立发布，不由根 `@zhcsyncer/pi-extensions` bundle 默认加载。

## 使用

同时加载两个独立扩展，限定本次会话可参与的模型，再用至少两条精确 route 调用命令：

```text
/adversarial-review \
  --reviewer provider-a/model-a@high \
  --reviewer provider-b/model-b@xhigh
```

目标可以是当前本地改动、`--base <ref>` 或 `--range <refA>..<refB>`。没有显式模型 scope 时核心会直接拒绝。Phase 1 不打开 picker，也不会在 merged report 生成后自动唤醒主模型。

## 安全

Reviewer 不继承主会话，只获得 `read`、`grep`、`find`、`ls`，不能编辑、修复或 commit。工具限制不是操作系统 sandbox；仓库内容仍属于不可信输入。

## 开发

```bash
pnpm --filter @zhcsyncer/pi-adversarial-review check
```
