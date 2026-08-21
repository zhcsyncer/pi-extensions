# @zhcsyncer/pi-adversarial-review

[English](./README.md) · [完整参考](./REFERENCE.zh-CN.md)

面向 Pi 的确定性多模型对抗式代码评审编排扩展。

## 状态

本扩展提供 Git 感知的输入冻结、2–8 路隔离 reviewer、保守 finding 收敛、可选独立 Refute、主模型裁决 handoff 和持久审计输出。检测到已安装且兼容的 protocol-v3 Subagents extension 时会使用它，否则通过 embedded backend 运行同一套 caller-owned 执行核心。

本包独立发布，不由根 `@zhcsyncer/pi-extensions` bundle 默认加载。

## 安装

```bash
pi install npm:@zhcsyncer/pi-adversarial-review
```

单独安装 `@zhcsyncer/pi-subagents` 是可选的。兼容的 external runtime 会增加共享队列和 FleetView 下钻；没有它时，Review 使用 embedded backend，而且不会注册 Subagents 工具、命令、scheduler 或 UI。

开始前，先用 Pi 的 `/scoped-models` 命令限定 Review 可使用的模型。

## 快速上手

TUI 模式下打开 setup picker：

```text
/adversarial-review
```

选择 2–8 条精确的 reviewer model/thinking route。没有 session 记忆的 route 初始为 disabled，首次启用进入 `medium`，或模型最接近的支持档位。已启用 thinking 档（含 `off`）用高亮；只有 `disabled` 保持暗色。Refute 默认启用：它使用当前主模型与精确 thinking level 创建全新 session；也可改用 scoped model 或关闭。

模型选择前，Git preflight 会 fetch，并识别它能够证明安全的 target。普通功能分支评审“相对远端默认分支的 committed changes + staged、unstaged、untracked”；同步的默认分支只评审 local work。歧义或高风险状态必须由 TUI 明确选择，绝不猜测。若自动识别出的功能分支 target 较大，普通 `/adversarial-review` 也会提供同一条连续“起点到 HEAD”commit 线，而不是自动 batch plan。

不想写 ref 或 hash，想直接打开这条 commit 线时，可使用：

```text
/adversarial-review --range
```

终点固定为捕获时的 `HEAD`。每个可见 first-parent commit 都能作为起点；每行直接写 `Start <sha> · reviews N commits · <commit-time> · <subject>`，因此可以在看到各起点提交时间的同时，选择 3 个、6 个或任意可见的连续数量。所选起点 commit 会被包含，起点到 HEAD 的完整范围在同一轮中整体评审。功能分支默认止于刚刷新过的远端默认分支 merge-base。超过建议阈值时，TUI 可确认整体评审所选范围，或回到同一 commit 线选择更近起点；超过硬上限时必须选择更近起点。

需要可复现或 headless 运行时，显式给出 target 和至少两条精确 reviewer route：

```text
/adversarial-review \
  --base origin/main \
  --reviewer provider-a/model-a@high \
  --reviewer provider-b/model-b@xhigh
```

Headless Refute 还必须给出精确 refuter route：

```text
/adversarial-review \
  --range HEAD~3..HEAD \
  --reviewer provider-a/model-a@high \
  --reviewer provider-b/model-b@high \
  --refute \
  --refuter provider-c/model-c@medium
```

Target 形式包括：

- `--local` — staged、unstaged 和 untracked local work；跳过 fetch，且绝不包含 commit。
- `--base <ref>` — 从 merge base 到 HEAD 的 committed changes，再加 local work。
- `--range` — 仅 TUI 的 commit 线：终点固定为捕获时 `HEAD`，任选最早包含的 commit。
- `--range <A>..<B>` — 精确的 committed-only range，并在扩展拥有、精确指向 B 的 detached worktree 中评审。例如最近 5 个 commit 使用 `--range HEAD~5..HEAD`。

Whole-target `--base` 和 `--local` 会自动冻结 staged、unstaged 和 untracked 内容，TUI 不再询问是否先提交。Committed `--range` 无法包含这些内容，因此 TUI 会询问是只继续评审 committed history，还是取消、提交后重跑。已位于 HEAD 历史中的本地 commit 本身就是 committed history，只要所选 target 覆盖它们就会正常进入评审。

完整要求、focus/需求输入、gating 和大目标处理见[命令参考](./REFERENCE.zh-CN.md#命令参数)。

## 一轮评审如何运行

1. **Preflight**：证明 Git target，并记录 branch/ref/fetch 决策。
2. **Freeze**：捕获一份确定、有界的输入；所有 route 读取同一证据。
3. **Review**：运行隔离的只读 agent。每个 reviewer 都收到相同的可信 charter、frozen evidence 和完整任务，并各自独立完成一轮全面对抗式评审。若 route 为 `invalid-output` 且保留了完整、未截断的 raw output，会在收敛前自动执行恰好一次同 route、无工具的格式修复。
4. **Converge**：校验 JSON、保守聚类各路独立产出的 finding，再应用 `weighted` 或 `strict` gate。修复结果只有在 host 侧证明它与原始输出中已经存在的唯一完整 ReviewReport 完全一致时，才计为有效 reviewer。
5. **Refute**：可选地把每个 blocking cluster 交给一个全新隔离 session。反证可以把 finding 标成 contested，但绝不能删除或降级它。
6. **Adjudicate**：持久化未取消的报告，并要求当前主模型/用户对照实际代码核验 blocking finding。扩展永远不声称最终通过。

Severity 衡量影响，confidence 衡量证据强度，votes 衡量独立印证。Weighted gate 下，cluster 达到 reviewer quorum 即 blocking；或者同一个原始 finding 自身为 `critical`/`high` 且 confidence 至少 `0.85`。不同 finding 的评级绝不会被拼接成门禁。

## TUI 可见性与工具面

`/adversarial-review` 是 slash command，不是主模型发起的一次 tool call。只安装或加载本扩展，不会给主 session 增加 Agent 工具。

运行期间：

- 暂停输入区统一承担紧凑的阶段/计数/耗时摘要、一行 `Snapshot → Review → Gate → Finish` 节点条、target、frozen input 大小、确定性的 gate/Refute 结果、真实 cleanup 进度，以及 `input paused · Esc to cancel`；只有 Refute 真正启动后才插入该节点，节点条不声称百分比；
- 扩展不再占用 Pi 的 footer status 区域，也不再注册独立的 editor 上方 widget；
- 使用兼容的 external Subagents runtime 时，逐 agent 的模型、执行、对话与 tool call 明细只由其 Agents/FleetView 展示，Review 状态卡不再重复这些行；
- embedded fallback 没有 FleetView，因此同一张输入区状态卡会保留有界的逐 agent 状态；
- reviewer 即将派发前，会用不进入模型上下文的持久 transcript 节点记录精确 frozen target 和请求的 routes；
- 最终报告是另一条独立的持久 transcript 节点：失败时折叠视图直接显示 route error，展开后包含每路终态以及完整 blocking/advisory finding 详情。

Reviewer/refuter session 不继承主会话。它们的 inline agent config 会关闭 extension 和 skill，只暴露 `read`、`grep`、`find`、`ls`。格式修复 session 只接收原始 raw output 与 parser error，没有 tool、extension、skill、frozen-input 路径或评审任务，并限制为 3 turns + 2 个收尾 turns。它只能移除 framing；若源文本不含恰好一个完整有效 ReviewReport，或任何语义值发生变化，该 route 仍保持无效。这些低层调用与修复细节不会在 Review 状态卡中重复刷屏。

Freeze/review/refute 期间按 Esc 只会打开确认界面，后台工作继续。默认选中 **Continue review**；只有选择 **Confirm cancellation** 才会 abort。输入区状态卡会一直保留到 runtime 真正终止、frozen workspace 真正清理完成，随后恢复正常编辑器。Preflight 与 picker 的 Esc 仍然立即取消。

## 结果语义

一轮运行会结束为：

- `candidate-approve` — 没有 blocking cluster 通过当前 gate；
- `needs-adjudication` — blocking 或达到 quorum 的 advisory 证据需要终裁；
- `inconclusive` — 成功完成的有效 reviewer 不足；
- `stale`、`cancelled`、`failed` — 均不具备通过资格。

`refuted=true` 表示 refuter 给出了有支撑的挑战。它会创建 `contested` 记录；原 blocking finding 保留，直到主模型或用户对照代码作出决定。已取消的 partial report 只为审计保留，绝不会自动触发主模型 turn。

报告会保留每条独立 route 的结果、已验证 finding、失败/无效尝试、每次格式修复前后的两份记录、runtime backend、gate 输入、Refute 结果和 target fingerprint。缺失或已被 64 KiB 上限截断的 raw output 不会进入修复；修复共享原整轮 deadline，单 route 最多两分钟。非 TUI 运行还会把私有 standalone audit 写到 `$PI_CODING_AGENT_DIR/extension-data/pi-adversarial-review/audit/`（默认 `~/.pi/agent/extension-data/pi-adversarial-review/audit/`）。

## 安全边界

Reviewer/refuter 工具限制属于纵深防御，不是操作系统 sandbox；仓库内容始终是不可信输入。

扩展不会编辑、修复或 commit 代码，也不会 merge、rebase、reset、prune 或切换用户真实 worktree。Range 评审使用 token-owned detached linked worktree；只要 ownership、容量、cleanup 或 Git state 无法证明，就会 fail-closed。Fetch 与 checkout 会禁用仓库控制的 hook、helper、filter、递归 submodule、replace ref 和继承的 Git repository context。

Whole-target 建议上限是 200 KiB 或 5,000 个逻辑行；硬上限是 1 MiB 或 25,000 行。无值 `--range` 会保持用户所选的连续“起点到 HEAD”历史：超过建议阈值时，确认整体范围或选择更近起点；超过硬上限时，只能选择更近起点或取消。它不会悄悄把所选范围替换成自动批次。显式的大 `--base` 或 `--range A..B` 仍保留确定性 commit-plan 诊断，供明确希望拆成独立 run 的用户使用。所有可读 label 背后仍以完整 SHA 作为精确身份。Headless 必须显式传 `--range` 或 `--allow-large`。

## 兼容性

| 组件 | 要求 |
|---|---|
| Pi | `>=0.84.0 <1`，提供 `ctx.scopedModels` 与 custom message renderer |
| Subagents | 可选；protocol `3` 且 `maxConcurrent >= 1` 时启用 external backend 与 FleetView |
| Node.js | `>=22.19.0` |

External runtime 不可用或不兼容时，会在执行前回退 embedded Review 并记录原因。一轮运行一旦选定 backend，后续失败不会切到另一个 backend 重跑。

## 完整参考

[完整参考](./REFERENCE.zh-CN.md)覆盖：

- Git 推断、fetch 失败处理和 revalidation；
- 全部命令参数与 headless 要求；
- reviewer charter、评级标尺、聚类、gating 与 Refute；
- TUI 生命周期和内部 spawn/tool-call 形态；
- 输入上限、timeout、parser、audit 与 adjudication handoff；
- fetch hardening、range 容量门禁、worktree ownership、cleanup 与 crash recovery。

## 回滚

等待运行状态清空，然后只移除这个独立扩展：

```bash
pi remove npm:@zhcsyncer/pi-adversarial-review
```

若其他工作流使用单独安装的 `@zhcsyncer/pi-subagents`，请保留它。移除 Review 不会修改仓库，也不会删除已有 session/audit entry。

## 开发

```bash
pnpm --filter @zhcsyncer/pi-adversarial-review check
```
