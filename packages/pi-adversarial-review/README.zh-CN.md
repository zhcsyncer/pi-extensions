# @zhcsyncer/pi-adversarial-review

[English](./README.md)

面向 Pi 的确定性多模型对抗式代码评审编排扩展。

## 状态

无 UI 核心、质量校准、scoped-model picker、独立反驳和主模型裁决 handoff 已经完成。本扩展可独立运行：检测到已安装且兼容的 protocol-v3 Subagents extension 时会使用它，否则通过 embedded backend 运行同一套 caller-owned 执行核心。本包独立发布，不由根 `@zhcsyncer/pi-extensions` bundle 默认加载。

## 使用

安装 Review 扩展，并限定本次会话可参与的模型：

```bash
pi install npm:@zhcsyncer/pi-adversarial-review
```

单独安装 `@zhcsyncer/pi-subagents` 变为可选：兼容的 protocol-v3 extension 会提供共享队列和每路 FleetView；没有安装时，Review 命令自动使用 embedded backend，而且不会注册 Agent 工具、命令、scheduler 或 Subagents UI。

在 TUI 模式下不传 reviewer 参数即可打开可搜索 picker：

```text
/adversarial-review
```

Reviewer picker 前会先运行 Git preflight。未显式选择 target 时，命令优先 fetch 当前分支 upstream remote，回退 `origin`，再回退唯一 remote，并从 remote HEAD、`main`、`master` 识别默认分支；若 remote HEAD 缺失且 `main`、`master` 同时存在，TUI 会明确询问基线，绝不猜测。普通功能分支自动评审“相对远端默认分支的 committed + staged + unstaged + untracked”；同步的默认分支只评审 local。默认分支含本地提交或已分叉、detached HEAD、Git operation、unmerged files、remote/default branch 歧义等情况会先让 TUI 用户选择，绝不会静默开跑；headless 模式则要求显式 target。

Fetch 失败时，TUI 可选择 Retry、使用现有 local remote-tracking ref 或 Cancel；preflight/fetch 进行中也可按 Esc 取消；headless 会 fail-loud。Preflight 不会自动 merge、rebase、reset、checkout 或 prune。每次决定都会在运行前显示 target、branch、ahead/behind 和 fetch 状态。模型选择后还会复核 HEAD、branch、精确 status、选中 ref SHA 和冻结 patch hash，并与最终 frozen input 再绑定；若 Git 已变化，TUI 会重跑 preflight，或在任何 reviewer spawn 前 fail-loud。

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
  --base origin/main \
  --reviewer provider-a/model-a@high \
  --reviewer provider-b/model-b@xhigh
```

显式目标可以是 `--local`、`--base <ref>` 或 `--range <refA>..<refB>`；它们会覆盖智能推断。`--local` 是明确的本地/离线模式，不 fetch；`--base` 和 `--range` 引用 remote-tracking ref 时会先刷新对应 remote。可选参数包括 `--reqdoc <path>`、`--focus <text>` 和 `--gating weighted|strict`。没有显式模型 scope 时命令会直接拒绝。TUI 运行期间，footer 显示整轮聚合进度，按 Esc 会通过同一 stop 路径取消整个 fleet。只有选中兼容的外部 Subagents runtime 时才提供每路 FleetView；embedded 运行的同等 route 细节仍完整保留在 audit report。

## 输出

每一路 reviewer 和每次 refuter 尝试都会保留，包括 provider error、timeout、cancel 和无效 JSON；保存的 raw output 保持有效 UTF-8，且包含 truncation marker 在内不超过 64 KiB。报告也会记录 Git preflight 的显式/推断/交互来源、branch、选中 remote、尝试与成功 fetch 的 remote、fetch 状态、ahead/behind，以及实际 runtime backend、fallback 原因、请求 route、并发上限、执行波次与 contested 证据。保守聚类优先避免把不同问题误合并成假共识；若多个 reviewer 各自提出未聚类 advisory，本轮仍要求裁决。确定性门禁只会产生 `candidate-approve`、`needs-adjudication`、`inconclusive`、`stale`、`cancelled` 或 `failed`，永远不声称最终通过。

Print 模式输出 merged report，但不启动模型 turn。Pi 会在 headless 模式保护 extension stdout，因此脚本应以进程状态而不是 stdout/stderr 分流来区分“已生成报告”和“运行故障”。Print/JSON 失败会把过滤控制字符后的诊断写入 stderr、持久化 error audit entry，并设置非零进程状态；RPC 模式会保留 error entry，但不会终止长驻 host。RPC client 可通过 `get_entries` 获取 `adversarial-review-report` 和 `adversarial-review-error` 两类 custom entry。其他成功的非 print 模式会持久化完整审计报告，并通过固定 follow-up 自动唤醒当前主模型。仓库/模型文本会按不可信数据编码；handoff 超过 128 KiB 时仍保留 audit，但 fail-loud 不启动模型，绝不静默截掉 finding。主模型必须查实际代码、逐条把 blocking 标成 valid/invalid 并给证据；涉及设计取舍时先问用户，而且不能自动编辑、修复或 commit。

## 安全

Reviewer 和 refuter 都不继承主会话，只获得 `read`、`grep`、`find`、`ls`，不能编辑、修复或 commit。自动 fetch 使用无 shell、有 timeout/取消、输出上限和 terminal cleanup 的独立进程组；仓库/环境提供的 SSH command、askpass/credential helper、未批准 transport、remote VCS/upload-pack override、hook、clean/process filter、递归 submodule fetch 与 maintenance task 均被禁用；fetch 错误不会回显可能含凭据的原始 stderr。Range snapshot 直接流式提取 commit raw blob、忽略 replace refs；冻结过程绝不执行配置的 textconv、clean/smudge/process filter 或 fsmonitor。Binary、LFS 和 submodule 限制会明确写进报告。临时目录限制权限，正常路径在 `finally` 删除；同 UID、非 symlink、超过 24 小时的 crash 残留会先原子移入 quarantine，再在下次运行清理。工具限制不是操作系统 sandbox；仓库内容仍属于不可信输入。

## 兼容性

| 组件 | 要求 |
|---|---|
| Pi | `>=0.84.0 <1`，提供 `ctx.scopedModels` 与 custom message renderer |
| Subagents | 可选；protocol `3` 且 `maxConcurrent >= 1` 时启用 external backend 与 FleetView |
| Node.js | `>=22.19.0` |

没有外部 Subagents extension 时会静默选择 embedded backend；旧版、畸形或不兼容 responder 会被忽略，同时给出警告并记录 fallback 原因。一旦选中兼容的 external backend，后续失败只记在该 backend 上，绝不会转去 embedded 重跑。缺少显式 model scope 时仍会在 spawn 前失败。

## 回滚

先按 Esc，并等待运行状态清空；然后只移除这个独立扩展：

```bash
pi remove npm:@zhcsyncer/pi-adversarial-review
```

若其他工作流仍使用单独安装的 `@zhcsyncer/pi-subagents` extension，不要移除它；随本包自动安装的 runtime 代码依赖会跟随本包一起移除。卸载不会修改代码仓，也不会删除已有 session audit entry。本包不在根 bundle 内，因此根 `@zhcsyncer/pi-extensions` 安装无需回滚。

## 开发

```bash
pnpm --filter @zhcsyncer/pi-adversarial-review check
```
