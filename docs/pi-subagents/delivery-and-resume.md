# pi-subagents 投递与续跑契约

## 意图与边界

子 agent 已经完成，不代表主模型已经读到报告；历史可以打开，也不代表原任务可以安全续跑。本契约把**结果进入推理**、**运行代次**与**可恢复历史**分开，避免预览冒充交付、旧完成污染新运行、恢复失败悄悄变成新任务。

用户用法见 [English README](../../packages/pi-subagents/README.md) / [中文 README](../../packages/pi-subagents/README.zh-CN.md)。本文固定跨模块的行为与 Why，不维护实现步骤或测试任务清单。早期投递问题背景见 [background-duplication.md](./background-duplication.md)；当前合同以本文为准。

## 报告必须进入模型上下文

Pi 的三个通道不能互相替代：

| 通道 | 作用 | 自动进入 LLM context |
| --- | --- | --- |
| 完成消息 / 工具结果的 `content` | 主模型可消费的报告 | 是 |
| `details`、TUI 预览与展开视图 | 展示与结构化状态 | 否 |
| `appendEntry` 的父会话 archive | 分支历史、恢复依据 | 否 |

因此不能只把完整报告放在 `details` 或 archive，再向模型发送一句“已完成”。完成通知优先携带完整最终报告；只有超过有界预算时才截断。这个预算限制的是自动注入的上下文，不删除完整结果，也不等于 TUI 预览长度。

### 消息预算与取回

- **每条实际发出的完成消息最多 16 KiB（16,384 字节）UTF-8**。计算完整发出消息，包括元数据、包装与转义后的开销，而非仅报告正文或 JavaScript 字符数。
- Individual 与 group 使用同一总量边界。一个 group 的所有报告共享一份预算，不能把 N 个各 16 KiB 的片段装进一条通知。
- 截断必须显式标注，保留可定位的 agent ID，并提示 `get_subagent_result(agent_id)` 获取完整结果；不能让被截断报告看起来完整。
- `get_subagent_result` 提供完整结果；`verbose: true` 提供包含工具输出的对话。自动通知不需要默认塞入整个工具对话。
- `wait: true` 仍是等待接口。取消只结束等待方，不停止 child、不消费其结果，也不吞掉将来的完成通知。

预算内完整报告让主模型可以直接综合；明确的取回路径让超长结果仍可核验。组共享预算是为了限制一次自动注入的总成本，而非限制一个 agent 能产出多少内容。

### 投递时机与所有权

| 来源 | 主 agent 忙碌 | 主 agent 空闲 |
| --- | --- | --- |
| 手动 Agent-tool background（含角色默认后台） | `steer`：当前已发出的工具结束后，下一次模型调用前 | `triggerTurn: true` 启动推理 |
| Scheduler / RPC detached | `followUp`：等待当前工具循环结束 | `triggerTurn: true` 启动推理 |
| Foreground | 结果由工具 inline 返回，不发送后台 nudge | 同左 |
| Caller-owned completion | 抑制单 agent 主会话 nudge，由调用方收口 | 同左 |

`steer` 不是撤销机制，不能收回同一 assistant turn 已发出的 sibling tools。前置调查仍应 foreground；background 仅用于有独立工作可做的情况。主 agent 保留综合与验证责任，但验证是高风险定向抽查，不是重做已委派的证据收集。

Caller-owned 只改变谁负责主会话收口，不取消排队、停止、生命周期事件或历史记录。

## 同一 ID 可以有多次运行

Agent ID 标识连续任务上下文，**运行代次（generation）**标识这一次执行。若仅按 ID 去重，续跑会被当作旧通知吞掉；若只清空一个去重标记，延迟中的旧完成又可能混入新运行。

因此：

- 完成去重按运行代次，而非 agent ID 的整个生命周期。
- Resume 开始时，尚被 hold/group 持有的旧代次完成必须失效；旧回调不得消费、完成或通知新代次。
- 新代次拥有自己的完成、等待、停止和通知生命周期；继续沿用相同 ID 不等于沿用上次终态。
- 这些约束处理进程内延迟与重复投递，不宣称跨崩溃 exactly-once。

## 统一 steering 与显式 resume

`steer_subagent` 的含义是“把后续要求交给同一 agent”，而不是要求调用方猜测它是否刚好完成：

| 当前状态 | 行为 |
| --- | --- |
| Running | 向当前运行追加 steering |
| Queued / initializing | 保存 pending steering，等 child 可接收时投递 |
| Completed / `steered`（软轮次上限收尾） | 自动沿同一 ID、同一上下文启动后台 continuation |
| Error / aborted / stopped | 拒绝；必须显式 `Agent(resume=id, prompt=...)` 才能重试 |

### Pi 1.1 的投递回执与结算

接受请求不等于模型收到输入。运行中的 SDK 回执 `queued` 映射为 manager 的 `steered`；扩展消费输入则返回 `handled`，不得重发或宣称排队。manager 自己暂存尚未就绪的输入返回 `queued`，成功终态后的续跑返回 `resumed`；拒绝保持 rejection。同步 UI `steer()` 的 boolean 只表示接纳。`subagents:steered` 事件携带同一 `disposition`，不能仅凭事件名推断已送达。

SDK 内部取消显示为 `aborted`，外部停止保持 `stopped`。这些显示状态和 `agent_settled` 都不是资源释放凭证：prompt、abort/idle 与在途 steering 全部结算后，才能发布终结结果、清理会话或释放并发名额。旧代回调不得改变新代状态。轮次限制的收尾指引只影响实际发生的下一次模型请求，不持久写入用户队列、不强迫额外一轮。

续跑失败或被停止不能抹掉上一份已完成报告。保留这一份历史报告，与本次状态和实际输出分开；查询、通知和结束报告视图明确标注历史归属，不把旧结果伪装成本次成功或部分输出。Child 文件损坏只影响对话明细，已存于父会话的报告仍可查看。这不改变恢复资格或用量水位，也不引入完整的历史版本查询系统。

完成后自动 continuation **只由明确的 steering 请求触发**，不是检测到终态就自行运行。软上限收尾与失败不同：它有可继续的正常上下文；错误、取消和停止则需要调用方明确承担重试的意图，不能被普通 steering 隐式重启。

显式 `Agent(resume=id, prompt=...)` 默认 foreground，与旧运行的前后台模式无关。加 `run_in_background: true` 后立即返回 queued/running，再进入与新后台运行相同的自动通知、等待与取消生命周期。自动或显式后台续跑都遵守并发上限，不因复用 session 绕过队列；前台续跑与首次前台运行一样绕过后台队列。

## 从 live 到磁盘的恢复边界

普通运行默认持久化；`persist_session: false` 或默认 `rememberAgents: false` 可选择 live-only，显式 `persist_session: true` 仍覆盖默认值。Live-only 在原记录和上下文仍保留时可 resume；eviction 或重启后没有保证。

磁盘恢复不是“找到一个 JSONL 就执行”。它要求同时具备：

1. **当前父会话分支上的有效终态 archive**，证明该 ID 在这个分支的最后可恢复状态；
2. **对应 child JSONL**，提供原对话；
3. **受支持的新版本恢复配置（recovery recipe）**，保留原渲染后 system prompt、tool policy、cwd、model、thinking 与 limits，避免用今天的角色文件或父会话默认值重新解释旧任务。

父 archive 负责身份、分支与终态资格；child JSONL 负责对话；recipe 负责运行意图。三者缺一不能推断出安全的续跑环境。原渲染后 prompt 与工具策略的保存，不代表冻结扩展代码或外部世界。

- 旧 archive 没有 recipe：仍可查看历史，但不可通过 Agent/steer 工具恢复执行；不尝试猜配置。
- 持久化的 error/aborted/stopped 终态可以在条件满足时显式 resume；普通 steering 不得自动重试。
- Pi 1.1 的 retain-none compaction 用自身 entry ID 标记未保留旧消息，这是合法恢复边界；不是对任意前向引用的放行。缺失引用、非法前向引用、重复 ID、损坏 JSONL 或 cwd 错误必须在 SDK 打开文件前拒绝，避免其宽松解析静默丢弃历史。
- 缺失、损坏或不支持的恢复资料，原 cwd 不可用（含已清理 worktree），原模型不可用：明确报错。
- 恢复失败不得静默新建 session、换成父模型/其他模型，或改用当前 checkout。用户若决定从头开始，必须另发不带 `resume` 的新 Agent 请求。
- 运行时重新加载当前安装的扩展、解析当前凭证。恢复不是进程/内存快照、不是环境复制，也不是沙箱；扩展 handlers 与外部副作用仍按当前环境执行。

### 为什么续跑前要作废旧终态

父会话在新一代运行获准时（包括进入等待队列之前）追加 **active-run tombstone**，使同一 ID 先前的完成 archive 不再具有恢复资格。新代次正常终结后，才有新的有效终态。

否则会出现危险的回退：旧任务已经完成 → 开始续跑并产生副作用 → 进程崩溃 → 重启后误把旧完成当成“最近状态”恢复。Tombstone 选择拒绝过时恢复，而不是假装新运行从未发生。它保留历史，但取消旧完成作为可执行恢复点的资格。

这不使运行中的工作可持久恢复：异常进程退出时的 in-flight 运行、排队任务/后续消息不作为 durable queue 重放；没有跨崩溃恰好执行一次的承诺。终态恢复是显式续跑，不是 crash replay。

## 子用量身份与父分支结算

子会话已记录的消费以 **child session ID＋SDK entry ID** 为身份，而不是文本、工具名、事件次数或查询时生成的 ID。assistant 与外层 toolResult 的 usage、独立 usage entry（包括未知 kind）、compaction/branch summary 的显式生成费用均纳入 lifetime。nested 工具事件只描述外层已经汇总的消费，不另加；摘要正文或 details 中的累计快照不是新增消费。未进入日志的重复事件不能直接增加账目。

实时记录与重新打开同一日志得到同一累计值；压缩不会删除日志中的原消费。旧版会话的 ID 由目标 SDK 迁移并写回，读取迁移后的稳定 ID，不自行猜测迁移身份。没有明确费用时 `lifetimeUsage.cost` 缺省；native Usage 的必填零值不能单独证明免费，应同时看累计标记中是否确有费用信息。

`onAssistantUsage` 保留为 assistant 事件观察入口，但其发生在持久化前且不涵盖所有消费，不能作为完整子账本。内部 `onSessionUsage` 是累计快照而不是增量；对外查询的 `AgentRecord.lifetimeUsage` 保留同一含义。旧 archive 与新快照按累计水位对齐，不能相加重计，也不能让旧快照降低水位。

父工具只报告尚未消费的增量，native `usage` 与 `details.subagentUsageRollup` 必须一起持久化。`UsageReporter.claim` 同步保留并发查询的本次份额，但切树后只以当前分支的持久报告重建已确认水位，不能携带被离开分支的内存 reservation。也覆盖“claim 后报告已写入，尚未再次查询便切树”的情况。互斥父分支的报告不能相加当作 child lifetime；读取 child 原账的消费者应忽略相应父 rollup，避免双计。
