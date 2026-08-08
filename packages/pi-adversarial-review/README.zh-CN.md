# @zhcsyncer/pi-adversarial-review

[English](./README.md)

面向 Pi 的确定性多模型对抗式代码评审编排扩展。

## 状态

无 UI 核心、质量校准、scoped-model picker、独立反驳和主模型裁决 handoff 已经完成。扩展依赖 `@zhcsyncer/pi-subagents` 的进程内 protocol-v3 契约。本包独立发布，不由根 `@zhcsyncer/pi-extensions` bundle 默认加载。

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

加入 `--refute` 会让独立 refuter 逐个挑战 blocking cluster。TUI 会再打开一个单 route picker；非交互模式必须显式传精确 `--refuter`：

```text
/adversarial-review --refute

/adversarial-review \
  --reviewer provider-a/model-a@high \
  --reviewer provider-b/model-b@xhigh \
  --refute \
  --refuter provider-c/model-c@high
```

每个 blocking cluster 都使用一个全新隔离 session。`refuted=true` 只会增加 contested 记录，绝不会删除或降级原 blocking finding；false、失败、超时和无效输出也都保留原 finding。

只做评审且要求可复现，或使用 RPC/JSON/print 模式时，仍须显式传至少两条精确 reviewer route：

```text
/adversarial-review \
  --reviewer provider-a/model-a@high \
  --reviewer provider-b/model-b@xhigh
```

目标可以是当前本地改动、`--base <ref>` 或 `--range <refA>..<refB>`。可选参数包括 `--reqdoc <path>`、`--focus <text>` 和 `--gating weighted|strict`。没有显式模型 scope 时命令会直接拒绝。TUI 运行期间，footer 只显示整轮聚合进度，每路细节仍由 Subagents FleetView 负责；按 Esc 会通过同一 stop 路径取消整个 fleet。

## 输出

每一路 reviewer 和每次 refuter 尝试都会保留，包括 provider error、timeout、cancel 和无效 JSON；保存的 raw output 保持有效 UTF-8，且包含 truncation marker 在内不超过 64 KiB。报告也会记录请求 route、runtime 并发上限、执行波次与 contested 证据。保守聚类优先避免把不同问题误合并成假共识；若多个 reviewer 各自提出未聚类 advisory，本轮仍要求裁决。确定性门禁只会产生 `candidate-approve`、`needs-adjudication`、`inconclusive`、`stale`、`cancelled` 或 `failed`，永远不声称最终通过。

Print 模式只输出 merged report，不启动模型 turn。其他模式会持久化完整审计报告，并通过固定 follow-up 自动唤醒当前主模型。仓库/模型文本会按不可信数据编码；handoff 超过 128 KiB 时仍保留 audit，但 fail-loud 不启动模型，绝不静默截掉 finding。主模型必须查实际代码、逐条把 blocking 标成 valid/invalid 并给证据；涉及设计取舍时先问用户，而且不能自动编辑、修复或 commit。

## 安全

Reviewer 和 refuter 都不继承主会话，只获得 `read`、`grep`、`find`、`ls`，不能编辑、修复或 commit。Range snapshot 直接流式提取 commit raw blob、忽略 replace refs；冻结过程绝不执行配置的 textconv、clean/smudge/process filter 或 fsmonitor。Binary、LFS 和 submodule 限制会明确写进报告。临时目录限制权限，正常路径在 `finally` 删除；同 UID、非 symlink、超过 24 小时的 crash 残留会先原子移入 quarantine，再在下次运行清理。工具限制不是操作系统 sandbox；仓库内容仍属于不可信输入。

## 兼容性

| 组件 | 要求 |
|---|---|
| Pi | `>=0.84.0 <1`，提供 `ctx.scopedModels` 与 custom message renderer |
| Subagents | `subagents:rpc:ping` 返回 protocol `3` 且 `maxConcurrent >= 1` 的构建 |
| Node.js | `>=22.19.0` |

Protocol 3 或显式 scoped model 不可用时，命令会在 spawn 前失败。请把本包与携带同一 protocol-v3 changeset 的 Subagents release 配对；最终版本号由 Changesets version PR 决定。

## 回滚

先按 Esc，并等待运行状态清空；然后只移除这个独立扩展：

```bash
pi remove npm:@zhcsyncer/pi-adversarial-review
```

若其他工作流仍使用 `@zhcsyncer/pi-subagents`，不要移除它。卸载不会修改代码仓，也不会删除已有 session audit entry。本包不在根 bundle 内，因此根 `@zhcsyncer/pi-extensions` 安装无需回滚。

## 开发

```bash
pnpm --filter @zhcsyncer/pi-adversarial-review check
```
