# Pi 1.1：单调度 session 与 Herdr worktree 执行编排

状态：用户已授权开工及此前说明的本地提交/集成流程；当前 session 调度并集成，使用 Herdr worktree 实施，进度统一在本文 §0 更新。已建立集成 worktree 并提交计划快照，E0 首轮交付已完成独立审阅，验证脚本问题退回原 session 返修，尚未释放后续实施；未推送、未合 main、未发布或更改真实账号配置。范围以[总计划](../pi-1.1-implementation-plan.md)为准，不重新授权冻结项。

## Goal 与编排决定

让一个调度 Pi session 持有全局依赖、范围和验收状态，各实施任务在独立 Herdr worktree 与 Pi session 中完成。并行只用于互不争抢代码所有权的任务，避免多代理同时改共享入口、锁文件，最后才集中解冲突。

- W0–W11 保留为功能工作包，不直接等同实施 session。实际派发单元应有一个独立验收结果；大型运行时/显示改造按前后依赖分段，同一模块保留同一负责人串行推进。
- 默认最多 **3 个实施 session 同时工作**；独立审阅按需追加 1 个只读 session。安装与全量测试等重负载默认最多同时 2 组；这是初始资源预算，不以开满终端为目标。
- **当前 session 是唯一调度者，不另建或迁移调度 session。** 当前会话负责合同、派发、审阅、串行集成与跨包验收；代码 Git 操作和集成验证明确指向专用集成 worktree，不 checkout/污染当前含用户改动的工作区。需要修实现时退回原任务 session；跨包新缺陷先划定归属再派发。
- 采用增量集成：每个任务通过审阅后进入集成分支，后续任务从包含其前置成果的固定提交创建；不要求无依赖任务等整批完成。
- 本轮交付只支持 Pi 1.1+；Consult 的 Pi 上游公开 SDK 入口适配已纳入。七项 BACKLOG、Antigravity、Herdr 命令体验、Search 登录识别/用量补报/配置串用修复均不做。

## 0. 统一进度表（调度 session 唯一写入）

**权威进度副本**：当前工作区的 `/root/develop/ai/pi-agent-cases/docs/pi-extensions/pi-1.1-execution-plan.md`。本会话唯一维护此表；集成与 worker 分支内的文档是派发时的规格/进度快照，不另立实时进度账。阶段性由调度者将获准的文档更新同步到集成分支，不能用 worker 的旧副本覆盖这里的新状态。实际调度身份与各路径在启动时补录；如未来必须交接调度者，先显式交接唯一写入权，不并行更新。

- **更新时机**：派发、收到交付、审阅/返修、发生或解除阻塞、集成并复验后立即更新；不按每次工具调用刷表。
- **状态**：`未派发 → 执行中 → 待审阅 → 可集成 → 已集成`；另有 `返修中`、`阻塞`。无代码变更的验证/材料任务以 `已验收` 结束；有代码的任务只有集成态复验通过才标 `已集成`。worker 自报完成或 Herdr done 均不算最终完成。
- **定位**：启动后填实际 worktree 路径及 Pi session ID，可附 Herdr agent/pane；不写虚构占位 ID。提交栏按“代码基线 → 交付 → 集成”记录，缺项保留 `—`，计划提交另列。
- **证据**：每行只写关键结果或阻塞及下一步；详细测试输出、报告和终端日志用路径/链接引用，不塞整段日志。`/var/tmp` 仅放产物，不再维护另一份任务状态表；本会话 Todo 如使用只作短期动作提醒，不成为第二份进度来源。
- **时间**：各状态变更使用本地 `YYYY-MM-DD HH:mm`，不使用 UTC ISO 字符串。表内 `—` 表示未发生，不是零成本/零失败。

初始化：2026-10-12 14:40（本地 CST）；开工：2026-10-12 14:52。

- 调度：当前 session `01a12e08-fb4e-7135-9f57-a5843fb8ce27`，Herdr pane `w3:p64`。
- 集成 worktree：`/root/.herdr/worktrees/pi-agent-cases/pi-1.1-integration`；分支 `upgrade/pi-1.1-integration`；Herdr workspace/pane `w9W` / `w9W:p1`。
- 已复核代码基线：本地 main 与 origin/main 均为 `f48a91b8366174f2ece5d393e280641be87fbb70`；#149/#150 head 与总计划一致。执行宿主仍为 Pi 0.87.1，不原地升级。
- 初始计划提交：`c7d251f0fc830b1587abd3cab95a3e40b47f82ce`；最新集成 SHA：`3be801ddd3cb84a2a1650dd3e48849a2608b2024`（首批合同及独立审阅修订，尚无产品代码集成）。
- 合同：[E0](./tasks/e0-baseline.md)、[R1](./tasks/r1-runtime-lifecycle.md)、[D1](./tasks/d1-renderer-semantics.md)、[K1](./tasks/k1-context7-offline.md)。依赖见 §2。
- 独立审阅资源：`/root/.herdr/worktrees/pi-agent-cases/pi-1.1-review`；session `pi11-review-20261012`；agent `pi11-review` / `w9Y:p1`。只读审阅合同，不代写实现或维护另一份进度。

| 任务 | 状态 | worktree / session | 基线 → 交付 → 集成 | 验收 / 阻塞与下一步 | 更新时间 |
|---|---|---|---|---|---|
| E0 基线与隔离环境 | 返修中 | `/root/.herdr/worktrees/pi-agent-cases/pi-1.1-e0`；`pi11-e0-20261012`；agent `pi11-e0` / `w9X:p1` | `c7d251f` → `411d3f8`（未接受） → — | 独立审阅阻断：安装副本误判/候选依赖身份、全局 offline 改变业务测试、HTML 夹具旧回调、全新缓存离线重装；见 E0 合同返修段。保留 R1/A1/N1 生产失败归属，撤回 D1 生产回归判断 | 2026-10-12 15:54 |
| R1 终态/恢复/费用水位 | 未派发 | — | — | 合同审阅完成，已补身份/分支数值样本；待 E0 SDK 证据及实施前公开测试入口交接 | 2026-10-12 15:11 |
| R2 会话授权边界 | 未派发 | — | — | 待 R1 | — |
| R3 child 装配 | 未派发 | — | — | 待 R2＋K1 | — |
| D1 renderer/语义保真 | 未派发 | — | — | 合同审阅完成，已补 Write 可观察结果；待 E0 loader 证据及测试 fixture 接口交接 | 2026-10-12 15:11 |
| D2 缓存/有界输出 | 未派发 | — | — | 待 D1 | — |
| D3 nested 投影 | 未派发 | — | — | 待 D2 | — |
| D4 消息样式/导航 | 未派发 | — | — | 待 D3 交回写所有权 | — |
| K1 Context7 离线合同 | 未派发 | — | — | 独立合同审阅无阻塞；待 E0，独立包队列优先 | 2026-10-12 15:11 |
| C1 Consult 公开 SDK | 未派发 | — | — | 待 E0 | — |
| F1 Todo＋Question | 未派发 | — | — | 待 E0 | — |
| H1 Herdr 兼容 | 未派发 | — | — | 待 E0 | — |
| N1 Fast | 未派发 | — | — | 待 E0 | — |
| N2 Search | 未派发 | — | — | 待 E0；三项旧债不做 | — |
| N3 Recap | 未派发 | — | — | 待 E0 | — |
| N4 Volcengine | 未派发 | — | — | 待 E0 | — |
| N5 Cursor | 未派发 | — | — | 待 E0；B02/B04 不做 | — |
| X1 外部 Ollama | 未派发 | — | — | 待 E0；已复核安装 0.13.0、来源 fgrehm/pi-ollama-cloud，须重验旧 0.12.2 诊断；本地源码树未确认 | 2026-10-12 15:40 |
| A1 Review 后端 | 未派发 | — | — | 待 R3 | — |
| P1 Plan 授权 | 未派发 | — | — | 待 R2＋K1 | — |
| M1 Meter 账本 | 未派发 | — | — | 待 R1 | — |
| G1 Glance 用量/主题 | 未派发 | — | — | 待 R1 费用合同 | — |
| M2 Go 额度 | 未派发 | — | — | 待 M1；Antigravity 不做 | — |
| I1 跨包/安装验收 | 未派发 | — | — | 待本轮实现集成与候选 SHA | — |
| L1 授权环境验收 | 未派发 | — | — | 待适用候选、机器/账号操作授权 | — |
| I2 交付材料 | 未派发 | — | — | 待验收汇总；变更候选须复验 | — |

## 1. 启动前置，不把编排确认当代码授权

1. 用户已在确认当前 session 调度方式后明确“开工”，授权本计划范围内实施及此前说明的任务分支本地 commit、向专用集成分支 cherry-pick。此授权不包含提交用户原有无关改动、推送、合入 main、关闭 issue、发版或更改真实账号配置。
2. 重新核对 origin、main/head、PR head 与实际加载来源。当前记录的 `f48a91b` 是计划分析基线，不是永久有效的执行基线；变化会影响合同的部分先重审。
3. 当前 session 在获准后从核定代码基线创建干净的专用 Herdr 集成 worktree，记录路径与分支；不另开调度 session。后续以明确 cwd 或 `git -C <集成路径>` 操作该树，不依赖终端当前目录。先核验本机 `herdr --help`、`herdr worktree`、`herdr agent` 与 Pi CLI 实际能力，不把过期命令例子当保证。
4. 在该集成 worktree 中固定已批准的计划快照，再启动 worker。当前总计划与包级规格存在未跟踪文件，**Git worktree 不会自动继承这些文件或其他未提交改动**。仅将本轮经确认的文档差异逐项复制/应用到集成分支，核对内容后形成计划提交并记录 SHA；不执行 `git add .`，不带入用户的 BACKLOG 等无关改动。原工作区只由当前 session 更新获准的计划/进度文档，不进行产品代码、分支或依赖变更。未获计划提交授权则停在准备态，不让 worker 使用缺失/过期的规格开工。
5. 将计划提交、集成 worktree/分支及调度身份登记到 §0；之后各任务的定位、提交、验收和阻塞只在该表维护。详细产物建议存放本机 `/var/tmp/pi-1.1-dispatch-<run-id>/` 并在表中引用，不另外建立 state.md/任务账本，不保存凭据或把终端操作流水塞进计划。

调度及实施 Pi 使用稳定、已知可用的宿主运行；待适配 Pi 1.1 在隔离测试环境中运行，不在执行中途替换正在调度的全局 Pi 或加载未验收扩展。测试 agentDir 不读取真实 auth，不自动信任项目脚本，不把 `--offline` 当作工具网络沙箱。

## 2. 派发粒度与批次

总顺序为：**基础环境 → 分模块适配 → 消费方/跨模块联接 → 完整验收**。批次是依赖层，不是整批统一开工/收工的屏障；只要前置成果已审阅并集成，调度者即可释放对应后继任务。

### 批次 0：共同基线（串行）

调度者先盘点来源/适用检查与各包依赖需求，再派 **E0** 给一个基础环境 session，不为“盘点、安装、修改 manifest、跑类型检查”各开 session。

| 任务 | W / 主写范围 | 独立交付与出口 |
|---|---|---|
| E0 基线与隔离环境 | W0；根及各包 manifest、workspace/锁文件、共享 check/pack/loader 测试夹具 | 精确 1.1 依赖图、16 包＋root＋外部来源清单、可重现离线安装/检查；包括必要 Terminal fixture。逐项记录生产适配失败的负责人，不替各任务修业务实现，也不要求尚未派发任务的问题已消失 |

E0 通过后固定集成 SHA。后续任务均至少依赖 E0；包间新增依赖需求回交 E0 负责人，串行发布新基线，不让所有 worker 各自改锁文件。

### 批次 1：三条队列滚动并行

这不是一次启动下面所有任务。调度者最多维持三名实施者：**运行时队列、显示队列、独立包队列**。队列只是调度分组，不要求一个 session 包办全部包；工作量变小时可以把空闲槽位用于其他已满足依赖的任务。

**运行时队列：R1 → R2 → R3，同一负责人串行。** 先完成生命周期与费用身份，让消费者能尽早接入；权限边界先于新能力装配，不能先启用再补安全。

| 任务 | W / 主写范围 | 前置及独立验收 |
|---|---|---|
| R1 终态、恢复与费用水位 | W1；`packages/pi-subagents` 的 manager/runner/恢复/usage 及测试 | E0；queued/handled/取消回执真实，实际终态后清理，合法/损坏恢复可区分，费用身份与父子去重合同可供消费者使用；不做 B10–B12 |
| R2 会话授权边界 | W1；同包执行 hook、可信工具身份、策略恢复 | R1；直接/多层 nested 的同一禁用动作均零副作用，恢复不扩大权限；冻结策略合同 |
| R3 授权 child 装配 | W1/W5；同包 SDK loader/factories 与离线 transport 集成 | R2＋K1 的离线接入合同；授权 child 可用 MCP/codemode，isolated/reviewer/repair 不扩权，未授权服务不连接；未启用模式仍正常 |

**显示队列：D1 → D2 → D3 → D4，同一负责人串行。** D4 排在 D3 后主要为了共享写路径不冲突，并非普通消息开关在功能上依赖 nested。

| 任务 | W / 主写范围 | 前置及独立验收 |
|---|---|---|
| D1 公共 renderer 与语义保真 | W3；`packages/pi-tool-display-intent` 注册/包装及对应夹具 | E0；真实注册，schema/context/采样/prepare 等不丢；普通工具和缺 displaySummary 的 Bash 正常，codemode grammar 不改 |
| D2 缓存与有界输出 | W3/#148；同包预览/外壳/预算 | D1；两层缓存可失效、有界，100/300 历史的组件重绘基准与真实输入验收分开记录 |
| D3 nested 实时与历史投影 | W3/#149；同包 aggregate/events/恢复 | D2；多层归根、去重、部分失败/取消和不完整历史正确；直接 codemode 的离线验收不等待 R3，child 场景在批次 3 联验 |
| D4 消息样式开关与导航 | W4/#150/#151；同包普通消息路由、marker、配置和双语说明 | D3（写所有权顺序）；两个功能作为一个任务联合验收，普通/steer 分流、两布局、cache-hit/marker ownership 正确 |

**独立包队列：优先 K1 解锁 R3，其余按依赖与槽位派发。** 下表各行为独立任务，不将 W6 四个包塞给一个 session；不以发现既有问题为理由顺带扩容。

| 任务 | W / 主写范围 | 独立验收 |
|---|---|---|
| K1 Context7 离线接入合同 | W5；`packages/pi-context7`、相关 skill/双语说明与离线夹具 | 旧 REST 保留；官方 MCP 与 codemode 独立；为 Plan/child 提供可测试的可信服务与工具授权合同。候选名字/schema 标明来源，模拟 transport 不冒充真实握手已核实；不修改真实 profile |
| C1 Consult 公开 SDK 适配 | W2；`packages/pi-consult` | 目标 1.1 的公开入口保留模型、账号/订阅、OAuth 派生信息、取消、无工具、预算和恢复；model-only，watchdog 不双计。公开入口不等价时报告阻塞，不偷偷改认证渠道 |
| F1 Todo＋Question 调用边界 | W2；`packages/pi-todo`、`packages/pi-ask-user-question` | 两个轻量包可共用一个 session：仅 model-only/既有生命周期与 TUI/RPC/blocked 回归，不统一内部架构；若需大改立即拆出新的明确任务 |
| H1 Herdr 既有能力适配 | W2/W11；`packages/pi-herdr-companion` | 进程 model-only、pane/session 所有权、BTW CLI child、OSC 双源与 blocked 回归；不改命令菜单/补全。全局 bridge 先只读核验，若需要修改须单列授权与来源 |
| N1 Fast | W6；`packages/pi-fast-mode` | 公开 hook、options/采样优先级及官方预算 fixture 一致；不扩展虚拟模型功能 |
| N2 Search | W6；`packages/pi-search-hub` | 直接调用与脚本结构化结果等价，原搜索路由/认证/取消不新增回归；登录、用量补报、配置串用三项不做 |
| N3 Recap | W6；`packages/pi-recap` | 现有物理模型侧路、命名与取消/加载兼容；明确旁路费用边界，不纳入虚拟路由/旧缺陷大修 |
| N4 Volcengine | W6；`providers/pi-provider-volcengine-agent-plan` | 正确 chat/compat 类型、tier/thinking/auth、流/取消/错误；原订阅渠道不变，不做额度自动刷新 |
| N5 Cursor | W10；`providers/pi-provider-cursor-ask` | 已选上下文重放与 1.1 兼容合同，真实协议离线 fixture、流/取消；保留上下文安全，不做 B02/B04 |
| X1 外部 Ollama | W6/外部资源；确认归属后的来源仓库专用 worktree | 明确受维护版本/fork 的交付来源；类型及工具/思考/额度兼容验收。不得改本仓或全局 node_modules 冒充交付，来源未知先阻塞 X1 |

N1/N2/N3/N5 等任务派发前，把总计划要求的“必要兼容/已选能力/独立旧债”归类落实到 AC；无法证明与允许范围有关的子项不得夹带。只有验证、不需要修改的包允许以真实适用回归证据交付，不为制造 commit 而重构；no-op factory 不算能力验收。

### 批次 2：消费者适配（前置一到即可穿插）

| 任务 | W / 主写范围 | 前置及独立验收 |
|---|---|---|
| A1 Review 执行后端 | W2；`packages/pi-adversarial-review`，含 `src/runtime/embedded-runtime.ts` | R3；external/embedded 一致，format-repair 无工具，执行后失败不双跑，真实安装解析已适配 runtime；不靠 workspace alias 掩盖依赖分裂 |
| P1 Plan 精确授权 | W2/W5；`packages/pi-plan-mode` | R2＋K1；model-only、审批/恢复不变，旧 REST 与已验证来源的 MCP 精确授权；planning 拒绝 Agent/codemode，不合入 relay。与 R3 的联验不代表 Plan worker 可改 Subagents |
| M1 Meter 账本适配 | W7；`packages/pi-meter` 的账本路径 | R1；assistant/outer/独立 usage 与父 Agent 汇总恰好计一次，live/import/reload 一致；不修旧注册/空闲重试 |
| G1 Glance 用量＋主题 | W7/W9；`packages/pi-glance` | R1 的费用合同；同一 session 同时负责用量读取与 theme.appearance/刷新兼容，避免两个 worker 同改 `runtime-snapshot.ts` 与刷新链；保留 working/Git/stash，不改大粘贴。与 Meter 对齐结果合同，不新造跨包账本框架 |
| M2 Go 额度来源 | W8/#152；`packages/pi-meter` 的 quota 与接线 | M1（同包写所有权顺序）；明确验证的协议、未知/耗尽/错误/reload 行为，真实订阅另验；不做 Antigravity，不借机修 B04/B05 |

### 批次 3：独立联验与交付准备

- **I1 跨包/安装验收**（W11）：由非原实现者的独立 Pi session 在专用验收 worktree 上，对冻结候选集成 SHA 执行完整 16 包/root 与安装矩阵；重点组合 R3＋K1＋P1＋D3、R1＋M1＋G1、R3＋A1、C1/N1/provider，保留未启用 codemode 的正式路径。E0 的已知失败到此必须清零，或报告未完成，不能带错关闭 I1。审阅若发现实现问题，仍回原任务返修，不由验收者顺手改实现。
- **L1 授权环境验收**（W5/W11）：真实 Context7/Go/provider、Ollama、Herdr/BTW、Mac TUI 等验收按明确账号/机器授权执行；Context7 仅该 profile 切换、保留回退。可以提前做获得授权的独立验证，但最终结果必须对应候选 SHA/实际包版本。没有 Mac 或账号授权时记录未验收，不把 I1 离线通过称为全部完成。
- **I2 交付材料**（W11）：调度者汇总各任务语义独立的 changeset、双语说明、pack/入口、实际包版本计划和未完成 issue，交用户 review。纯汇总不改变候选；若补入文档、changeset、入口或打包修订，须重新固定候选 SHA 并重跑受影响的文档/pack/安装/运行检查，按明确影响判断复用既有真实环境证据，不能把旧 SHA 的全部结果直接盖到新候选。后续 push/main/version PR/发布/宿主切换保持各自授权门槛；不是 worker 收工就自动发布。

**覆盖核对**：Subagents=R1–R3，Tool Display=D1–D4，Context7=K1，Consult=C1，Todo/Question=F1，Herdr=H1，Fast/Search/Recap/Volcengine=N1–N4，Cursor=N5，Review=A1，Plan=P1，Meter=M1/M2，Glance=G1；root=E0/I1/I2。外部 Ollama=X1；全局 bridge=H1 核验＋L1 联验，其他排除资源不启动。

## 3. 文件所有权与集成边界

| 写入区域 | 所有权规则 |
|---|---|
| 根/各包依赖声明、workspace overrides、锁文件、共享 check/pack/安装夹具 | 基线任务统一持有；后续 worker 提交依赖变更请求，不各自重写锁文件。基线完成后交回调度者，必要变更派同一基础环境任务串行处理 |
| Subagents runtime/runner/manager 与恢复/费用状态 | 同一实施负责人串行子任务；Review、Meter 消费已集成的合同，不反向修改其运行时实现 |
| Tool Display 注册/renderer/aggregate/用户消息路由 | 同一显示负责人串行交付；缓存、nested、导航不得由多个 worker 同时改共享入口 |
| Meter 与 Glance 的用量记录，以及 Glance 的主题/输入 | R1 先提供费用身份合同；M1 只写 Meter，G1 把 Glance 用量＋主题/刷新合为同一任务，两者可并行。Go 在 M1 交回 Meter 所有权后接入，不跨包争抢写入 |
| Context7 的本地接入、Plan/child 的授权、显示接入 | Context7 任务定义服务识别与接入事实；各消费者由原包负责人接线，不用一个 MCP worker 跨包抢改 |
| 各包 README/README.zh-CN 与包级变更说明 | 对应任务维护成对用户说明；用户可见变更附语义独立、文件名不冲突的 changeset，包含需要联动的 root；不直接改发布版本号，不写未验收支持声明 |
| 总计划、任务合同、全局运行状态、根 bundle 发布说明与版本 review 汇总 | 调度者唯一维护；worker 返回待修订事实，不自行改全局范围/状态 |

每个任务的允许写集合包含实现、对应测试与包级文档，排除其他任务所有权。目录不同也不必然无依赖：installed embedded、费用归属、MCP 授权等必须通过合同与前置提交连接。

## 4. 一次派发的最小交接包

任务开工前已有 Goal/AC/Design/Test Impact；含 T0/T1 的任务先完成 Contract 与测试用例设计。调度者提供：

- 任务 ID、目标和对应包级规格；明确本轮允许/禁止行为，不只发送 W 编号或“按计划修好”。
- 固定的计划提交与代码 base SHA、已经集成的前置成果、允许写文件/目录和共享文件负责人。
- 可观察的验收合同、测试层级、已知基线失败及环境约束；外部请求/账号/配置另需授权。
- 明确提交权限、禁止 push/main merge/release、禁止顺手修冻结事项；遇到硬依赖冲突应停止受影响部分并报告。
- 必读规则绝对路径：`/root/.agent-vm-state/pi/agent/AGENTS.md`、`/root/.agent-vm-state/pi/agent/rules/coding.md`、`/root/develop/AGENTS.md`，以及任务 worktree 自身 `AGENTS.md`。涉及 Pi API 时完整读取对应目标版本文档与相关交叉引用，不能以调度宿主版本替代目标 SDK。
- 交付回复：代码提交/基线、实现的 AC、测试命令与结果（通过/失败/未跑分别写）、未验证边界、范围外依赖；正常先通过 agent 回复回收，不预先要求所有 worker 另写一份长报告。

实施与独立测试编写可共用合同但不共用工作树。高风险权限/状态/费用用例由独立测试作者按固定合同与基线编写，不先阅读待测新实现；测试路径由调度者分配。测试作者完成后冻结测试交付，“用例已交付”不等于任务“验收完成”，对未实现合同预期失败不得标为通过。调度者在临时候选验收 worktree/分支组合实现与测试，运行通过并完成审阅后，两者作为该任务一起进入“可集成”；不要求任一方在尚未组合的独立树中通过全部合同，从而避免互等。组合需要的本地提交操作仍受启动授权约束，候选失败不进入正式集成分支，也不通过放宽合同迁就实现。审阅者在实现后阅读实际 diff 与相关调用链，不以模型自报“完成”代替检查。

## 5. Herdr 会话生命周期

- 每个实施任务使用 `herdr worktree create` 的明确 repo/base/branch/path；创建结果中的 workspace/pane 等 ID 原样记录，不预测或复用旁边用户的终端。
- 在该 worktree 的可用 shell pane 中以 `herdr agent start ... --kind pi` 启动独立 Pi session；确认 agent ready 后，通过 `herdr agent prompt` 派发。不以当前主会话的内置子 agent 代替约定的实施 session。
- 实施前由 worker 回报 cwd、origin、base、规则/规格读取情况及允许写范围；不匹配时不进入编辑。依赖安装放 worktree 所在本地盘或 `/var/tmp`，不要把大体积依赖放 `/tmp`，也不要让不同提交共写同一个 node_modules。
- 同一任务的返修优先复用原 worktree/session；同一模块后继子任务可在前一项已集成、工作树干净且同步到指定基线后复用负责人和环境。发生新目标或上下文失真时建立新 session，并显式交接，不靠无限累积历史维持记忆。
- `idle/done` 仅表示 agent 暂停，`unknown` 不表示成功。调度者收齐交付、diff、测试与审阅后才能验收。通过 Herdr 等待已知生命周期并读取结果，不高频轮询；若屏幕回滚无法取得完整结果，才请原 agent 将完整报告写入临时文件并返回路径。
- 遇到 `blocked` 或启动失败先读取状态/界面；涉及授权的问题交用户决定，不自动按确认键、不自动扩大工具权限。模型/API 失败恢复同一任务身份，不能另开重复任务同时写同一归属。
- 回收前确认成果已进入集成分支且交付记录可恢复；不强删有未提交差异的 worktree。只清理由本次调度创建的 pane/workspace；复用的用户资源不自动关闭。

## 6. 任务验收、集成与回退

任务状态统一在 §0 进度表维护；失败退回原任务返修，阻塞记录原因和解除条件。状态不由 Herdr 灯号或提交存在与否自动推导，集成操作完成但集成态测试未通过时仍不得标记“已集成”。

1. Worker 完成范围内实现与测试，交付本地任务提交；未通过自己的 AC 不可进入“可集成”。对未归属本任务的既知基线失败单列，不伪造全仓通过。
2. 调度/独立审阅核对实际 diff、调用方、测试契约、冻结项和无关文件；公共 API/权限/费用高风险必须有对应集成或数值证据。
3. 调度者串行将已接受提交集成到专用分支，每次记录来源提交及目标集成 SHA。不盲目解决语义冲突；与已集成任务重叠时，退回原负责人对最新基线返修、重审相关验收。
4. 在集成态重跑任务相关测试和受影响消费者 smoke，通过后才释放依赖它的任务。可并行任务若基线较旧，不必每有新提交就打断同步，但它的成果必须在集成态重新验证。
5. 新基线造成回归时暂停依赖链；在授权范围内回退本轮集成提交或交回修复，不 reset/丢弃用户改动。已经接受的实现因新冲突需返修，另记录返修任务，不把旧测试结果当当前通过。

所有非 main 分支若后续获准推送，推送前 fetch origin/main，未基于最新 origin/main 则 rebase，并重跑受影响检查。该发布前同步不等于任务间可以各自拉取/改写他人的分支。

## 7. 最终关口与非自动操作

- **机器验收**：全部 16 子包/provider 与根 bundle 的适用检查、真实 loader/installed embedded、pack/全新及升级安装、普通模式与 codemode 混合调用。不能只跑根 check 或只在 workspace alias 下通过。
- **外部与真实环境**：Ollama 在自己的来源仓库/任务环境交付，不手改 node_modules；全局 Herdr bridge 与实际安装树做专项回归。Mac 真实输入/导航、Context7 握手、Go 额度与 provider 认证等由明确授权的环境执行；未跑就标未验收。排除资源仍保持排除。
- **本地 Context7 切换**：离线集成不需要用户凭据；授权后单独执行真实握手与仅该 profile 的入口切换，保留旧扩展回退。不能让其他任务等待真实账号才能编译或跑离线合同。
- **交付/发布分离**：编排完成不代表已授权推送、合 main 或升级用户宿主。用户可见变更附 changeset，根 bundle 按嵌入包联动；调度汇总实际更新包的当前/目标版本供 review，再走 Changesets version PR。Antigravity 和其他冻结诉求不因此关闭。

本文是本次执行规格与实施期间的统一进度入口；交付后先保留完整记录，稳定后保留目标、验收结论和编排/安全决策，再蒸馏 Git/session 可恢复的执行细节，不在稳定交付前删掉进度依据。
