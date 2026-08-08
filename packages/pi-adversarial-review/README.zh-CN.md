# @zhcsyncer/pi-adversarial-review

[English](./README.md)

面向 Pi 的确定性多模型对抗式代码评审编排扩展。

## 状态

无 UI 核心、质量校准和 scoped-model picker 已经完成。扩展依赖 `@zhcsyncer/pi-subagents` 的进程内 protocol-v3 契约。本包独立发布，不由根 `@zhcsyncer/pi-extensions` bundle 默认加载。独立反驳和自动主模型裁决仍属于后续阶段。

## 使用

安装/加载两个独立扩展，并限定本次会话可参与的模型：

```bash
pi install npm:@zhcsyncer/pi-subagents
pi install npm:@zhcsyncer/pi-adversarial-review
```

在 TUI 模式下不传 reviewer 参数即可打开可搜索 picker：

```text
/adversarial-review
```

每个 scoped model 可在 `disabled` 与其支持的 thinking level 之间切换；被 scope pin 的模型只能选择 `disabled` 或固定 level。选择 2–8 路后激活 **Run selected reviewers**；按 Esc 会在任何 reviewer 启动前取消。有效选择只在当前 Pi session 内记忆，已移出 scope 的 route 不会复活。

需要可复现运行，或使用 RPC/JSON/print 模式时，仍须显式传至少两条精确 route：

```text
/adversarial-review \
  --reviewer provider-a/model-a@high \
  --reviewer provider-b/model-b@xhigh
```

目标可以是当前本地改动、`--base <ref>` 或 `--range <refA>..<refB>`。可选参数包括 `--reqdoc <path>`、`--focus <text>` 和 `--gating weighted|strict`。没有显式模型 scope 时命令会直接拒绝。TUI 运行期间，footer 只显示整轮聚合进度，每路细节仍由 Subagents FleetView 负责；按 Esc 会通过同一 stop 路径取消整个 fleet。

## 输出

每一路 reviewer 都会保留 route result，包括 provider error、timeout、cancel 和无效 JSON；报告也会记录请求 route 数、runtime 并发上限与执行波次。保守聚类优先避免把不同问题误合并成假共识；若多个 reviewer 各自提出未聚类 advisory，本轮仍要求裁决。确定性门禁只会产生 `candidate-approve`、`needs-adjudication`、`inconclusive`、`stale`、`cancelled` 或 `failed`，永远不声称最终通过。Print 模式直接输出 merged report；其他模式持久化审计 entry，并把报告排到下一次用户 turn，但不会自动唤醒主模型。

## 安全

Reviewer 不继承主会话，只获得 `read`、`grep`、`find`、`ls`，不能编辑、修复或 commit。工具限制不是操作系统 sandbox；仓库内容仍属于不可信输入。

## 开发

```bash
pnpm --filter @zhcsyncer/pi-adversarial-review check
```
