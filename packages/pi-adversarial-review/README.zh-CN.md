# @zhcsyncer/pi-adversarial-review

[English](./README.md)

面向 Pi 的确定性多模型对抗式代码评审编排扩展。

## 状态

Phase 1 无 UI 核心已经完成。它使用显式 reviewer route，并依赖 `@zhcsyncer/pi-subagents` 的进程内 protocol-v3 契约。本包独立发布，不由根 `@zhcsyncer/pi-extensions` bundle 默认加载。模型 picker、独立反驳和自动主模型裁决仍属于后续阶段。

## 使用

安装/加载两个独立扩展，限定本次会话可参与的模型，再用至少两条精确 route 调用命令：

```bash
pi install npm:@zhcsyncer/pi-subagents
pi install npm:@zhcsyncer/pi-adversarial-review
```

```text
/adversarial-review \
  --reviewer provider-a/model-a@high \
  --reviewer provider-b/model-b@xhigh
```

目标可以是当前本地改动、`--base <ref>` 或 `--range <refA>..<refB>`。可选参数包括 `--reqdoc <path>`、`--focus <text>` 和 `--gating weighted|strict`。没有显式模型 scope 时核心会直接拒绝。

## 输出

每一路 reviewer 都会保留 route result，包括 provider error、timeout、cancel 和无效 JSON。保守聚类优先避免把不同问题误合并成假共识；若多个 reviewer 各自提出未聚类 advisory，本轮仍要求裁决。确定性门禁只会产生 `candidate-approve`、`needs-adjudication`、`inconclusive`、`stale`、`cancelled` 或 `failed`，永远不声称最终通过。Print 模式直接输出 merged report；其他模式持久化审计 entry，并把报告排到下一次用户 turn，但不会自动唤醒主模型。

## 安全

Reviewer 不继承主会话，只获得 `read`、`grep`、`find`、`ls`，不能编辑、修复或 commit。工具限制不是操作系统 sandbox；仓库内容仍属于不可信输入。

## 开发

```bash
pnpm --filter @zhcsyncer/pi-adversarial-review check
```
