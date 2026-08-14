# Adversarial Review 完整参考

[English](./REFERENCE.md) · [返回 README](./README.zh-CN.md)

本文档规定 `@zhcsyncer/pi-adversarial-review` 的命令、runtime、gating、UI、audit 与 Git 安全行为。

## 命令模型与 runtime 工具面

`/adversarial-review` 是 Pi extension slash command。它不会注册成 LLM tool，主模型也不会发出 `adversarial-review` tool call。只要没有调用该命令，Review 就不会给主 session 增加 Agent 工具、prompt、scheduler、后台进程或 FleetView surface。

Preflight、target freeze 与 route 选择完成后，Review 会通过兼容的 Subagents protocol-v3 runtime 或 embedded adapter 发送 caller-owned spawn 请求。Role input 的概念形态如下：

```ts
{
  role: "reviewer" | "refuter",
  prompt: "可信编排指令与 frozen-input 路径",
  systemPrompt: "可信 reviewer 或 refuter charter",
  cwd: "仓库根目录或 detached range worktree",
  model: selectedModel,
  thinking: exactThinkingLevel,
  maxTurns: boundedTurnLimit,
  correlationId: "run-id:role:ordinal",
  description: "仅供显示的 route/finding 描述"
}
```

每次请求都使用 inline agent config 创建全新 session：

```ts
{
  builtinToolNames: ["read", "grep", "find", "ls"],
  extensions: false,
  skills: false,
  promptMode: "replace",
  persistSession: false
}
```

因此 reviewer/refuter agent 不继承主会话，也不能调用 `bash`、`edit`、`write`、Agent 或 extension tool。可信 system prompt 与 frozen patch、仓库文本、需求文档、focus、finding 和仿 marker 文本严格分离；后者始终是不可信数据。

Caller-owned delivery 只改变 terminal result 的接收者。选中 external backend 时，queue、stop、history、FleetView 和 terminal lifecycle 仍由 Subagents 管理。Runtime 只有确认 terminal event 中 requested/effective 的 provider、model、thinking 与所选 route 完全一致后，才接受报告。

## Git preflight 与 target 推断

Reviewer picker 前先运行 preflight。未给出显式 target 时，它会：

1. 选择当前分支 upstream remote，回退 `origin`，再回退唯一 remote；
2. 通过 hardened process fetch 该 remote；
3. 从 remote HEAD、`main` 或 `master` 识别远端默认分支；
4. remote HEAD 缺失且 `main`、`master` 同时存在时询问 TUI 用户；
5. 比较当前分支与所选默认分支，形成候选 target。

普通功能分支评审“相对远端默认分支的 committed changes + staged、unstaged、untracked”。同步的默认分支只评审 local work。已经位于 HEAD 历史中的 commit 本身就是 committed history，无需再次提交；只要所选 target 覆盖它们就会进入评审。存在 staged、unstaged 或 untracked 内容时，whole/local target 会明确询问是直接纳入还是取消后先提交。Committed range 则询问是排除这些内容后继续，还是取消、提交并重跑。默认分支含本地提交或已分叉、detached HEAD、进行中的 Git operation、unmerged files、remote/default branch 歧义都必须由 TUI 明确决定。Headless 会 fail-loud，并要求为这些状态显式给出 target。自动推断或交互选择出的“默认分支到 HEAD”target 较大且包含分支 commit 时，普通 TUI setup 会提供固定 HEAD 的连续 commit 线，不调用自动 commit planning。若只有 local changes，则只提供 whole-target 或取消，不显示空 range picker。

Fetch 失败时，TUI 可选择 Retry、使用现有 local remote-tracking ref 或 Cancel。Preflight/fetch 进行中按 Escape 会立即取消。Headless 模式直接 fail-loud。Preflight 永不 merge、rebase、reset、checkout 或 prune。

无值 `--range` 会直接打开同一条仅 TUI commit 线。B 固定为捕获时的完整 `HEAD` SHA；每个可见 first-parent commit 都按从新到旧显示为 `Start <short-sha> · reviews N commits · <committer-time> · <subject>`。时间取 Git 的严格 ISO-8601 committer time，并保留记录时的 UTC offset。任意一行都可作为最早包含的 commit，因此无需预设就能选择 3 个、6 个或其他任意可见的连续数量。内部 A 使用所选 commit 的完整 first-parent SHA，因此显示的起点 commit 本身会被包含，用户无需理解 Git `A..B` 左端点排除语义。所选“起点到 HEAD”始终是一份 review target 和一份报告，绝不会被悄悄替换成自动批次。功能分支会先刷新 preferred remote，并把候选限制在 HEAD/默认分支 merge-base 之后。无法证明该边界或仓库为 shallow 时，TUI 会明确说明只展示本地可见 first-parent 历史。最多展示 128 项。Detached HEAD、进行中的 Git operation、unmerged files 和只有 root commit 的历史会在模型选择前拒绝。Staged/unstaged/untracked 内容不属于该范围；显示 commit 线前，TUI 会要求明确选择“只继续评审 committed history”或取消后先提交这些内容。TUI 之外，无值 `--range` 会失败，必须使用精确 `--range A..B`。

所选 target、branch、ahead/behind、fetch 状态与测得的输入规模会在执行前显示，并进入报告。模型选择后以及第一次 spawn 紧邻之前，还会复核 HEAD、branch、精确 status、所选 ref SHA、target hash 与 frozen input hash。Picker 打开期间 Git 变化时，TUI 会重跑 preflight；更晚的 mismatch 会在任何 reviewer 启动前失败。

Remote/ref 与无值 range 的 commit 线都使用稳定 value 表示 Git identity；截断后的显示 label 永远不会用于反查选择值。显式 target 的 commit-plan row 同样绑定到完整、不可变的 SHA pair。Commit subject 只是不可信显示元数据：控制字符与双向文本控制符会被中和，长标题按 Unicode code point 安全截断；label 永不参与 identity 恢复。

## Reviewer 与 Refuter 选择

TUI setup 要求从 `ctx.scopedModels` 选择 2–8 条精确 reviewer route。每个没有记忆的 model 初始为 `disabled`。首次启用进入 `medium`；若模型不支持 `medium`，使用 Pi AI thinking-level clamp 返回的最近档位。之后可轮换全部支持档位。Scope-pinned model 只能使用 `disabled` 或固定 level。

有效选择只在当前 Pi session 中记忆。已移出 scope 的 entry 会立即清除，即使之后重新加入也不会复活旧选择。

同一个 setup picker 控制 **Refute blocking findings**：

- **main session**（默认）使用当前主模型和精确 thinking level，在全新 session 中运行；
- **choose model** 在 reviewer 确认后打开 scoped 单 route picker；
- **disabled** 跳过 Refute。

主 session model/thinking route 缺失或不兼容时，setup 回退 **choose model**，不会阻断普通 Review。任一 picker 按 Escape 都会在 reviewer 启动前取消。

显式 `--reviewer` 会绕过组合 setup picker。TUI 中传 `--refute` 但不传 `--refuter` 时，会优先使用兼容的主 session route，否则打开 scoped refuter picker。TUI 之外所有 route 都必须显式、可复现。

## Review 策略与 finding 评级

每个 reviewer 都在可信 system-prompt 层收到同一份完整 charter、相同 frozen evidence 和相同任务指令。每条 route 都必须独立完成全面评审，覆盖：

- 信任边界与 abuse resistance；
- 状态与数据完整性；
- 并发与故障恢复；
- 兼容性与运维；
- 通用正确性和其他 material regression。

系统不会按 route 分工，也不会暗中分配不同 focus。任何 reviewer 都不能假设其他 route 会覆盖某个方向。所选 route 可以使用不同模型或 thinking level，但评审范围与证据完全相同；只有每路完整评审结束后才进行聚类和计票，因此 agreement 表示独立交叉印证，而不是协作式专门化。

Requirement 只是产品 contract 证据，`--focus` 会向每个 reviewer 增加同一份共享关注。二者都不能覆盖 charter、压制其他 material finding，也不能把仓库中的指令提升为可信 policy。

Finding 分成三个轴：

- **Severity（影响）：**`critical` 表示系统性失陷、广泛权限绕过、大范围不可逆数据损害或无法恢复的全局故障；`high` 表示现实路径上的严重损害；`medium` 表示有意义但受限或有条件的影响；`low` 表示范围窄但仍属实质行为缺陷，不能用于样式或清理。
- **Confidence（证据）：**`0.95–1.00` 表示端到端直接代码证据；`0.85–0.94` 只剩常规推断；`0.70–0.84` 含一个明确假设；`0.50–0.69` 证据不完整，只有明确说明缺失证明时才应报告；更低分数属于推测，不应形成 finding。
- **Votes（印证）：**保守 cluster 所代表的独立 reviewer route 数量。

有效 finding 还必须包含仓库相对路径和行号范围、category、被违反的 invariant、实质问题与影响、具体证据和可执行的修正方向。

## Gating 与 Refute 语义

Review report 只有通过 schema 和语义校验后才参与收敛。聚类刻意以 precision 为先：只有 file、category、位置和机制都能安全对齐时才合并。不同问题宁可保持分离，也不能制造假共识。

`weighted` gating 下，cluster 满足以下独立票数即 blocking：

```text
max(2, ceil(validReviewers / 2))
```

另一条例外是：同一个原始 finding 自身同时具有 `critical`/`high` severity 和至少 `0.85` confidence。来自不同报告的 severity 与 confidence 绝不能拼成 single-high 例外。其他有效 cluster 为 advisory；但 advisory 覆盖 reviewer quorum 时仍需裁决。`strict` 会把每个有效 cluster 都放入 blocking。

只有满足以下条件才运行 Refute：已请求 Refute、存在兼容 route、gate 产出 blocking finding，且 review 不是 stale、cancelled 或 failed。每个 blocking cluster 使用一个全新隔离 refuter session。Refuter 只尝试用实际代码证据证伪该 finding，不执行第二轮通用评审。

`refuted=true` 表示 refuter 的有效输出支持该挑战。Review 会把 finding 记为 contested，但不会删除、降级或解除 blocking。`false`、provider failure、timeout、cancel 和 invalid output 都保留原 finding。当前主模型或用户才是最终裁决者。

没有 blocking finding 时会明确显示 Refute skipped，并且不消耗 refuter 模型。执行过的报告会显示有效 refuter 尝试数与 contested 数，包括零。

## 命令参数

| 参数 | 含义 |
|---|---|
| `--local` | 显式本地/离线 target：staged、unstaged 和 untracked；不 fetch，也不包含 commit。 |
| `--base <ref>` | 从 `<ref>` 与 HEAD 的 merge base 到 HEAD 的 committed changes，再加 local changes。Remote-tracking ref 会先刷新。 |
| `--range` | 仅 TUI 的 commit 线：截至捕获时 `HEAD`，任选最早包含的 first-parent commit。 |
| `--range <A>..<B>` | 精确的 committed-only range，在扩展拥有、精确指向 B 的 detached linked worktree 中评审。 |
| `--reviewer <provider/model>@<thinking>` | 精确 reviewer route；重复 2–8 次。 |
| `--refute` | 请求在 blocking finding 通过 gate 时执行独立 Refute。 |
| `--refuter <provider/model>@<thinking>` | 精确 scoped refuter route；必须配合 `--refute`。 |
| `--reqdoc <path>` | 附加仓库内的 regular requirement file；拒绝 symlink escape。 |
| `--focus <text>` | 增加共享但不可信的评审关注点。 |
| `--gating weighted\|strict` | 选择 convergence gate；默认 `weighted`。 |
| `--allow-large` | Headless 中显式接受超过建议阈值的 target；不能覆盖硬上限或 range checkout 容量门禁。 |

Target 参数互斥，并覆盖自动推断。无值 `--range` 可交互选择任意连续的“起点到 HEAD”数量；五个 commit 的可复现精确等价形式是 `--range HEAD~5..HEAD`。`--local` 不包含 commit。未传 reviewer flag 时必须在 TUI 中选择。TUI 之外必须给出精确 target 和至少两个 `--reviewer`。Headless Refute 必须同时传 `--refute` 与 `--refuter`。

示例：

```text
/adversarial-review --local

/adversarial-review \
  --base origin/main \
  --reviewer anthropic/claude@high \
  --reviewer openai/gpt@high \
  --reqdoc docs/feature.md \
  --focus "failure recovery" \
  --gating strict
```

## Target freeze 与 range worktree

所有 route 都读取同一份 immutable frozen input，其中包含 run metadata、可信 charter 副本、可选 requirement/focus、changed-file names、raw patches 和输出 contract。Input path 属于本轮私有目录。Reviewer 必须完整读取后再下结论。

`--local` 与 `--base` 允许 reviewer 在实时仓库根目录中做只读核验，但所有评审证据都在 spawn 前冻结。它们不会改变用户的 HEAD、branch、index、tracked files 或 untracked files。

`--range A..B` 只包含 committed 内容。无值 `--range` 会立刻把选择固化成不可变的完整 `parent(oldest)..HEAD_SHA`，之后进入同一流程。当前 worktree 必须位于具名分支，且 B 必须是该分支当前 HEAD 的祖先。Detached HEAD、已分叉或不相关的 B 都会在模型选择前被拒绝。

每个 range（包括干净的 B=current-HEAD）都会在私有 run 目录下创建一个扩展拥有、精确指向 B 的 detached linked worktree。所有 reviewer 与 refuter route 共用该只读 inspection view。用户真实仓库根目录绝不会被 range inspection 复用、切换或改写。

Frozen raw Git patch 始终是权威证据。Binary、LFS、submodule、sparse/missing-object 与 patch-context 限制会进入 `limitedContext`，绝不会隐藏。

## 输入上限、turn 与 timeout

Whole-target 建议阈值是 200 KiB 或 5,000 个逻辑行。这是质量和资源信号：同一 patch 与 context 会复制给 2–8 个隔离 reviewer，因此大输入会成倍增加 provider 成本、延迟、内存与证据稀释风险。测量使用确定性的 UTF-8 bytes 与逻辑行，而不是 provider-specific token 估算。

无论从普通 TUI setup 还是无值 `--range` 进入 fixed-HEAD commit 线，用户选择的连续“起点到 HEAD”范围始终是权威 target。超过建议阈值但低于 1 MiB / 25,000 行时，TUI 提供 **Review all N selected commits together**、**Choose a closer start commit** 或 Cancel；确认整体运行后使用大目标 turns/timeouts。超过硬上限时，同一条 commit 线只显示更近起点；若单个 commit 自身也超过上限，必须缩减附加 context 或拆分该 commit。Commit 列表只针对捕获时 HEAD 查询一次，重选时复用；该路径禁用自动 commit planning。

显式的大 `--base` 或 `--range A..B` 仍保留 **Review by commit plan**，作为用户明确想拆成独立 run 时的确定性诊断。其 row 继续按完整 frozen bundle 测量并绑定完整 SHA pair。分析上限仍是 first-parent 前 128 个 commit 和最多 8 个 plan item；不完整覆盖会明确报告。Headless 绝不隐式选择：必须传精确 `--range`；只有 target 仍低于绝对上限时，`--allow-large` 才能批准 whole-target。

| Role / target | Max turns | 单 route timeout | 整轮 timeout |
|---|---:|---:|---:|
| Reviewer / 普通 | 25 | 10 分钟 | 20 分钟 |
| Reviewer / 已批准大目标 | 40 | 20 分钟 | 30 分钟 |
| Refuter / 普通 | 12 | 5 分钟 | 15 分钟 |
| Refuter / 已批准大目标 | 20 | 10 分钟 | 30 分钟 |

可配置 grace turns（默认 5）与 wall-clock deadline 仍会约束收尾。只有通过相同 identity 与输出校验后，`steered` terminal event 才会被接受，并记录为 `turnLimited`。

用户请求 commit plan 或触及硬上限时，诊断只显示实际超过相关阈值的维度。SHA-bound、非空的普通替换段会按完整 frozen bundle 对 200 KiB / 5,000 行建议阈值重新测量；大 single commit 还会按绝对上限再次测量。TUI 选中后自动保留所有非 target 参数；复制 headless 命令时也必须保留。Base plan 只覆盖 committed changes，并明确提示未提交内容仍需 `--local`。若单个 commit 超过硬上限，应缩减附加 context 或拆分该 commit。

## TUI 生命周期与取消

Review 使用四个显示面，各自职责不同：

1. **Editor 上方 run card：**统一承担紧凑 phase、completed/running/queued 计数、耗时、一行离散的 `Snapshot → Review → Gate → Finish` 节点条、target、frozen input 大小、确定性的 gate/Refute 结果和 cleanup state。只有 Refute 真正启动后才插入该节点；Finish 覆盖报告发布与真实 cleanup barrier。它只表达阶段，不表示百分比或剩余时间。Review 不再占用 Pi 的 footer status 区域。
2. **Subagents Agents/FleetView：**external backend 下，逐 agent 的模型、执行、对话、token 和 tool step 明细只归这里，Review 卡不重复 agent 行。Embedded fallback 没有 FleetView，因此 Review 卡会保留有界的逐 agent 状态。
3. **派发 transcript entry：**第一次 reviewer spawn 紧邻之前，持久的 `adversarial-review-dispatch` entry 会记录 run ID、精确 frozen target、input size、请求的 routes、backend、gate 和 Refute 选择。它可读、可展开，但不进入模型 context。
4. **终态 transcript entry：**持久的 `adversarial-review-result`、cancellation 或 error entry 关闭可见生命周期。非成功报告的折叠视图直接显示 route failure；展开后包含每路终态、duration/usage、完整 blocking/advisory finding、Refute 和 target 详情。Adjudication handoff 使用另一条隐藏 custom message，因此不会重复显示最终报告。

状态卡最多十行；embedded overflow 会指向最终报告。控制字符会被清理；完整 Git identity 留在 audit/report，临时状态卡只使用短 identity 提示；长行按 terminal width 截断。中间 card 状态是临时 UI，不会写入模型 context；派发与终态 entry 会持久化，但同样不进入模型 context。

Freeze、review、refute 期间按 Escape 会打开明确的取消选择，但不会停止工作。默认选中 **Continue review**；在该项按 Enter，或在确认界面按 Escape，都会回到同一个运行。只有 **Confirm cancellation** 才会 abort 共享 run signal。

External shutdown 会跳过确认。无论哪种路径，UI ACK 都不是 terminal 真值：命令会等待 agent terminal settlement、Git process exit、runtime dispose 和 frozen workspace cleanup。状态卡会一直保留到该 barrier 完成，随后销毁；cleanup 失败时会保留可恢复资源并给出 warning。Freeze 完成后的 cancelled report 会作为 partial audit evidence 持久化，但绝不会唤醒主模型或排入 adjudication。Git preflight 和 reviewer/refuter picker 仍保持 Escape 立即取消。

## 报告与 parser contract

每次 reviewer/refuter 尝试都会保留，包括 provider error、timeout、cancel 与 invalid output。Reviewer 通常必须返回一个裸 JSON object，首尾非空白字符分别为 `{` 与 `}`。

作为最窄的 provider robustness fallback，reviewer parser 也接受“前置说明 + 恰好一个 `json` fence，且 closing fence 位于输出末尾”。提取出的唯一 balanced object 仍走原有 schema 与语义校验。额外 object、非 JSON fence、截断输出和 closing fence 后文本仍然无效。

保存的 raw output 保持有效 UTF-8，且包含 truncation marker 在内最多 64 KiB。Raw output 与 error 会进入 audit，但不会进入 live progress snapshot。

Merged report 会记录：

- preflight 是 explicit、inferred 还是 interactive；
- branch、remote、尝试/成功 fetch、fetch state、ahead/behind 与 input size；
- target/frozen-input fingerprint 与 limited-context marker；
- requested independent routes、backend/fallback reason、concurrency、waves 与实际 limits；
- 每次 reviewer/refuter 的 terminal status、usage、duration、`turnLimited`、parsed result、raw output 或 error；
- blocking、advisory 与 contested 证据；
- `candidate-approve`、`needs-adjudication`、`inconclusive`、`stale`、`cancelled` 或 `failed` overall state。

任何状态都不代表最终批准。`candidate-approve` 只表示没有 blocking cluster 通过当前确定性 gate。

## 持久 audit 与 adjudication handoff

TUI 的派发、结果、取消和运行故障边界都会作为不进入模型 context 的 session entry 保留，并通过 custom entry renderer 显示。Report 与 dispatch 节点带展开提示；非成功报告在展开前就会显示有界的 route error。每个非 TUI 完整报告或错误还会以私有权限原子写入：

```text
$PI_CODING_AGENT_DIR/extension-data/pi-adversarial-review/audit/
```

默认路径为 `~/.pi/agent/extension-data/pi-adversarial-review/audit/`。该 standalone store 独立于 Pi session flush policy，并拒绝 extension-owned symlink traversal。

Frozen input 完成前的已确认取消，只有在 freeze 以本轮 run-signal 的精确 abort reason 拒绝、且 temporary-workspace cleanup 成功时，才生成带版本号的最小 audit。它包含 preflight target、请求的 reviewer/refuter metadata、gating 与时间戳，绝不伪造 frozen hash 或 route result。并发 input failure 与 cleanup failure 仍按错误处理。Pre-freeze cancellation 会在所有模式持久化，并保留为 `adversarial-review-cancellation` session entry。

Pi 会保护 headless extension stdout。脚本应使用 process status，而不是假设 stdout/stderr 分流，来区分“已生成报告”与“运行故障”。Print/JSON failure 会输出过滤控制字符后的 stderr 诊断、持久化 error audit 并设置非零状态。RPC host 保持运行，并通过 `get_entries` 暴露 `adversarial-review-dispatch`、`adversarial-review-result`、`adversarial-review-error`、`adversarial-review-cancellation`；隐藏的 `adversarial-review-report` custom message 只承载主模型 handoff。

Print mode 只输出 merged report，不启动 model turn。未取消且成功的非 print 模式会向当前主模型发送固定 evidence-first follow-up；cancelled report 只持久化，不使用 `triggerTurn`。仓库与模型文本会编码为不可信数据。Handoff 超过 128 KiB 时，audit 仍保留，但 delivery 会 fail-loud，绝不静默截断 finding。

主模型必须查看每条 blocking finding 对应的实际代码，给出 concrete evidence 后标记 valid/invalid，涉及产品/设计取舍时先询问，而且不能自动编辑、修复、commit 或声称最终通过。

## 安全 hardening

Reviewer/refuter session 只暴露 `read`、`grep`、`find`、`ls`；工具限制不是 OS sandbox。本包面向可信本地仓库，同时始终把仓库与模型文本视为不可信评审输入。

自动 fetch 使用无 shell、有 timeout/cancel、输出上限与 terminal cleanup 的 process group。仓库/环境提供的 SSH command、askpass 与 credential helper、未批准 transport、remote VCS/upload-pack override、hook、clean/process filter、递归 submodule fetch 与 maintenance task 都会被禁用。可能含凭据的 raw fetch stderr 永不回显。

Frozen patch capture 使用 raw Git 输出、忽略 replace ref，并禁用配置的 textconv 与 content filter。Git subprocess 会清除继承的 `GIT_DIR`、`GIT_WORK_TREE`、index/common/object/alternate-object path、动态 config parameter、replace-ref base 与 namespace。Review 永不调用 broad `git worktree prune`。

## Range 容量与 crash recovery

注册 detached range worktree 前，Review 会测量 B 的完整递归 tree。初步硬上限是 100,000 个 entry 与 2 GiB raw logical blob data。

Checkout 文件系统初始时必须保留“512 MiB 加两倍 raw tree bytes”的加法余量。Worktree admin 与 index 还需要“16 MiB 加每个 tree entry 256 bytes”的确定性余量。若 temporary path 与 common-Git path 位于同一文件系统，两份余量会合并后对一个 available pool 检查；否则分别检查。容量失败会在 `git worktree add` 前报告 measured、allowed、available 与 required；没有 override flag。

创建会先持久化带版本号的 PID lease，并经历 `workspace → pending → owned`。随后执行 token-locked `git worktree add --detach --no-checkout`，再做 hardened、非递归 reset。Hook、clean/smudge/process driver、LFS smudge、fsmonitor、untracked cache、replace ref、递归 submodule、optional lock、继承 Git context、CRLF conversion 与 live symlink 都会被禁用；committed symlink 会成为普通 target-text file。由于 raw blob size 可能低估 Git 内建 checkout expansion，reset 会持续执行 512 MiB free-space floor、等待进行中的测量，并在 Git 成功退出后做最终测量。

正常 cleanup 采用 worktree-first，并经历 `registration-removing → completed`：证明精确的 token-owned checkout 与 admin marker，持久化 removal intent，只删除该 locked registration，持久化 completion，最后删除私有 run 目录。验证或删除失败会保留可恢复状态，不会删除不确定 metadata。

同 UID 的 24 小时 scavenger 会跳过自身当前工作目录与存活 owner PID。对 stale run，它会先原子 quarantine，再把证明过的精确 admin entry 从 `.git/worktrees` 移到 common-Git 文件系统上 token-derived 的私有目录。删除前会立即复核 device/inode、marker、lock token、checkout identity 与 substitution protection。证明缺失或不匹配、path substitution、畸形状态、碰撞和用户 worktree 都会保留；永不 broad prune。

## 兼容性与 backend fallback

| 组件 | 要求 |
|---|---|
| Pi | `>=0.84.0 <1`，提供 `ctx.scopedModels` 与 custom message renderer |
| Subagents | 可选 protocol `3`；`maxConcurrent >= 1` 时启用 external backend 与 FleetView |
| Node.js | `>=22.19.0` |

缺少 external extension 时会静默选择 embedded Review。旧版、畸形或不兼容 responder 会被忽略，同时给出 warning 并记录 fallback reason。缺少显式 model scope 会在 spawn 前失败。

Embedded stop/dispose 会等待真实 terminal settlement，并受 Review 专属 30 秒 deadline 约束。错过 deadline 时 cleanup 失败，并保留 frozen input 与可能存在的 detached worktree；abort ACK 永远不会被当作 terminal。

每轮只选择一次 backend。选中兼容 external backend 后，后续失败保留在该 backend 上，不会转到 embedded 重跑。

## 回滚

取消或等待 active run，然后等状态清空后再移除包：

```bash
pi remove npm:@zhcsyncer/pi-adversarial-review
```

若其他工作流使用单独安装的 `@zhcsyncer/pi-subagents`，请保留它。卸载不会修改仓库，也不会删除已有 session/audit entry。根 `@zhcsyncer/pi-extensions` 不包含 Review，因此无需回滚。

## 开发

```bash
pnpm --filter @zhcsyncer/pi-adversarial-review check
```
