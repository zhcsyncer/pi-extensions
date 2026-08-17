# pi-todo 长 session 有界状态设计

## 状态

已实施，待合入。

本方案只解决已经确认或明确要求解决的六项行为：

1. `list/get` 不再重复保存全量 replay checkpoint；
2. 当前任务全部终态后，下一次创建任务自动开始新周期；
3. 任务 ID 在 session 内保持单调递增；
4. 默认 `list` 隐藏 completed，只报告数量；
5. 模型不能直接 hard clear，用户通过确认 UI reset；
6. 模型在每次 agent run 中获得简短、精确的 active Todo 摘要，因此 compact/resume/tree 后无需依赖有损摘要猜测当前任务。

明确不引入显式 Plan、planGoal、close_plan、archive、history 查询或多 Agent 调度。

## 背景与代码事实

当前 `pi-todo` 的相关行为：

- 所有任务共享一个 session 级 `tasks` 数组；
- `completed/deleted` 一直留在数组中，直到 `clear`；
- 每次成功 Todo 调用，包括只读 `list/get`，都在 tool-result `details` 中保存完整 `tasks + nextId`；
- replay 扫描完整 branch，以最后一个合法 Todo 快照恢复状态；
- `session_start/session_compact/session_tree` 能恢复插件 store 与 widget，因此插件状态恢复本身不是缺陷；
- tool-result `details` 不作为模型可读文本参与常规模型上下文或 compaction 摘要；compact 后模型可能不知道精确任务 ID、状态和计划顺序；
- widget 在下一 agent turn 隐藏 completed 只是显示行为，不会缩小持久化状态；
- model-callable `clear` 无确认地清空任务并把 `nextId` 重置为 1。

因此需分开处理：

- **session 增长**：减少无意义 checkpoint，并让旧周期任务不再进入未来 checkpoint；
- **插件恢复**：保留现有 branch-aware last-valid-checkpoint 优势；
- **模型恢复**：主动提供短 active 摘要，而不是假设 compact summary 会保留结构化状态。

问题严重程度仍需基准验证；本方案不声称 Todo 一定是整个 session JSONL 的主要体积来源。

## 产品定位

> Todo 是单 Agent 当前多阶段工作的有界、有序执行焦点，不是整个 session 的历史任务账本，也不是方案或执行审计文档。

它的核心价值是在上下文膨胀、compact、resume 和 tree 切换后，让模型继续看到当前任务与后续顺序，避免跑偏。大版本方案、并发批次、关键决策、阶段结果和可追溯执行过程应保存在独立设计/执行文档与原始 transcript 中；Todo 不承担这些长期知识职责。Todo live state 只服务当前仍相关的一组串行里程碑。

## 非目标

- 不提供用户可见的 Plan 或 generation 概念；
- 不保存 archive，不提供 history scope；
- 不把 Todo 变成 issue tracker；
- 不实现跨 session 共享或多 Agent claim；
- 不表达依赖图、并发批次或调度 DAG；
- 不引入 delta/event sourcing；
- 不重写已经存在的 session JSONL；
- 不按时间、turn 数或 compact 次数清理任务。

## 完整行为

### 1. 何时使用 Todo

模型仅在调用前已经能够列出至少两个有独立完成价值的里程碑时使用 Todo。以下信号可以说明存在多任务计划，但任何一个都不能单独豁免最低多项要求：

- 至少有 3 个有独立完成价值的阶段；
- 用户一次提出多个可拆分交付物；
- 存在能形成独立里程碑的验证工作或明显多阶段流程；
- 用户明确要求 Todo/任务列表，且实际内容确有多个里程碑。

新 Todo 周期绝不能以单任务计划开始，不因风险、耗时、重要性或预计工具调用数量而例外。只有一个里程碑时直接执行；一个 subject 只有在确实合并了不同结果（例如“复审”和“交付”各自具有独立完成价值）时才拆分。不得为了满足数量制造填充任务，也不得把一个紧密的 edit-test 循环强拆成两项。其他任务完成或按需求删除后，周期中只剩一项未完成或可见任务是正常状态，不应补充填充项。简单问答、单个文件读取和每条命令同样不得创建 Todo。

建议保持 3–7 个里程碑；超过约 12 个时 guidance 提醒聚合，不设总任务数硬上限。空状态或全部终态时，reducer 拒绝顶层 create 和 create 数少于 2 的 batch。

### 2. 初始创建

初始 batch 的自然顺序是默认串行执行顺序，不再维护独立依赖图；后来出现的插入工作临时改变顺序时，唯一 `in_progress` 是权威即时焦点。当前状态为空或刚 rollover 时，必须用一次至少含两条 create 的 batch 按执行顺序创建初始计划并启动第一项；顶层 create 或只有一条 create 的 batch 会被拒绝。顶层 create 仅用于向已有活动多任务周期末尾追加后来发现的里程碑：

```json
{
  "action": "batch",
  "operations": [
    { "action": "create", "subject": "研究现状", "status": "in_progress" },
    { "action": "create", "subject": "实现修改" },
    { "action": "create", "subject": "验证结果" }
  ]
}
```

不新增 `start_plan`、`planGoal` 或任何用户可见周期操作。

### 3. 任务生命周期

保留现有单 Agent 约束：

- 全局最多一个 `in_progress`；
- 开始工作前先标记 `in_progress`；
- 实现完整且必要验证通过后才标记 `completed`；
- 测试失败、实现不完整或有 unresolved error 时不得完成；
- 遇到独立插入工作时，可在同一 batch 中把当前任务 requeue 为 `pending`，并创建插入任务为 `in_progress`；
- 插入工作完成后，再恢复原任务；
- 状态交接优先使用有序原子 batch。

Todo 不记录“为何插入”或依赖边；这些原因若有长期追溯价值，应写入执行文档。当前 `in_progress` 表示即时焦点，任务自然顺序表示初始计划顺序。

状态转换保持：

```text
pending → in_progress → completed
pending → completed             # 仅补记已完成工作
in_progress → pending           # 插入工作驱动的 requeue
pending/in_progress/completed → deleted
deleted → terminal
```

任务可按用户意图删除为 tombstone；不存在依赖边或 dependent 删除保护。

`owner/metadata` 为兼容保留，默认 guidance 不鼓励使用。

### 4. 隐式周期与自动 rollover

周期只作为内部状态，不进入模型 schema、工具输出或 widget。

定义：

```ts
const hasActiveTasks = tasks.some(
  task => task.status === "pending" || task.status === "in_progress"
);
const allTerminal = tasks.length > 0 && !hasActiveTasks;
```

触发规则：

- 顶层 `create` 在空状态或 `allTerminal` 时直接失败，不再单独开新周期；
- 顶层 `batch` 开始时若为空或 `allTerminal`，必须至少含两条 create；满足后先 rollover（仅 `allTerminal`），再执行整个 batch；
- batch 执行过程中不二次检查 rollover。若一个 batch 先完成旧任务再创建后续任务，这些操作仍属于同一周期；
- 当前仍有 pending/in-progress 时，create 继续追加到当前列表，runtime 不猜测用户是否切换目标；
- 不自动删除活动周期内的单个 completed/deleted。

示例：

```text
调用前：
#10 completed
#11 deleted
nextId = 12

batch create "研究新问题" + create "下一步"

调用后：
#12 pending 研究新问题
nextId = 13
```

旧任务仍存在于之前的 session entries 与历史 branch，但不再进入新 checkpoint。

### 5. Task ID

`nextId` 在同一 session 内始终单调递增：

- rollover 不重置；
- 用户 reset 不重置；
- 新 session 才从 1 开始。

这避免 transcript、branch 和模型语境中不同周期重复出现同一个 `#id`。

### 6. List/Get

默认 `list` 只输出可行动任务：

```text
[in_progress] #12 实现修改
[pending] #13 验证结果
2 completed tasks hidden
```

规则：

- 默认显示 `pending/in_progress`；
- completed 只报告数量；
- deleted 默认隐藏；
- `{ status: "completed" }` 明确查询当前周期 completed；
- `{ status: "deleted", includeDeleted: true }` 明确查询 deleted；
- 不新增 history scope；rollover 前的任务只能通过 transcript/tree 查看。

`get` 可读取 live state 中任意状态的任务；rollover 后旧任务不再属于 live state，`get` 返回 not found。

### 7. 用户确认 Reset

从 model-facing `TodoParamsSchema` 和 guidance 中移除 `clear`。模型不得主动清空 Todo。

`/todo` TUI 增加 Reset current todos：

1. 显示将清除的任务数量；
2. 若存在 pending/in-progress，显示额外警告；
3. 用户二次确认后清空 `tasks`；
4. 内部 generation 加一；
5. 保持 `nextId`；
6. 写入 branch-scoped、版本化状态 checkpoint，使 reload/tree 可正确恢复 reset 后状态。

非 TUI 模式不提供需要确认的 reset。

Reset checkpoint 可使用专用 custom entry；replay 按 branch 顺序同时识别 Todo mutation checkpoint 与 reset checkpoint，以最后一个合法状态为准。custom entry 必须只保存 live state，不复制历史。

旧 V1 快照中的 `action:"clear"` 继续正常 replay；无需重新执行旧工具调用。新模型 schema 不再接受 clear。

### 8. 模型可见 Active Todo 摘要

在每次 `before_agent_start` 中，如果存在 pending/in-progress，向本次 agent run 的系统提示尾部追加一个短且稳定的状态段：

```text
Current Todo state:
- #12 in_progress: 实现修改
- #13 pending: 验证结果
- 2 completed tasks hidden
```

规则：

- 仅包含 pending/in-progress 的 ID、status、subject 和 completed 数量；
- 不包含 description、metadata、deleted 或旧周期任务；
- 按 task 自然顺序输出；
- 无 active task 时不追加；
- 内容由当前 store 在 agent run 开始时生成；
- 同一 run 中后续 Todo mutation 通过 tool result 告知模型变化；下一 run 重新生成；
- 追加在系统提示尾部，尽量保持前缀缓存稳定；
- 不写 session entry，因此不会增加 JSONL；
- 自然覆盖 startup/resume/reload/compact/tree 后的下一次 agent run。

实现阶段必须验证 Pi 在 auto-compaction retry 中是否重新触发 `before_agent_start`，以及本次修改后的 system prompt 是否覆盖整个 agent loop。若不能满足，允许改用等价的 `context` 注入，但产品行为保持不变：模型每次开始工作时看到精确 active Todo。

实施实证（锁定依赖 Pi 0.84.0）：`before_agent_start` 在顶层 `AgentSession.prompt()` 进入 agent loop 前触发一次，返回的 override 随即写入 `agent.state.systemPrompt`；overflow compaction/retry 在同一个 `_runAgentPrompt()` 中通过 `agent.continue()` 续跑，直到整个 loop settled 后才清除 override。因此 hook 不会在 retry 时二次触发。若同一 run 已发生 Todo mutation，起始 system 段可能过期，且对应 tool result 可能落入 split-turn 的被摘要前缀；实现因此在 run-start 摘要发生变化后，通过不落 session 的 `context` 事件向后续每次模型调用补充精确 `Current Todo state update`。这保留了 system-prompt 起始契约，并消除了 compact/retry 的陈旧状态歧义。

### 9. Widget

维持现有 widget 心智模型，不显示 generation：

```text
Todos (1/3)
├─ [>] 实现修改
└─ [ ] 验证结果
```

- completed 继续显示到下一 agent turn，然后隐藏；
- overflow、高度预算、图标和动画行为保持；
- rollover 后只展示新周期任务；
- reset 后立即移除 widget。

## 状态与持久化

### V2 live state

```ts
interface TaskStateV2 {
  tasks: Task[];
  nextId: number;
  generation: number;
  revision: number;
}
```

- `generation`：rollover/reset 时加一，仅内部调试与 replay 使用；
- `revision`：每次成功 mutation/reset 加一，用于诊断和测试，不进入 UI 或模型摘要；
- V1 live state 读取时初始化 `generation = 1`、`revision = 0`。

### Envelope

Mutation tool result：

```ts
interface MutationDetailsV2 {
  schemaVersion: 2;
  kind: "checkpoint";
  action: "create" | "update" | "delete" | "batch";
  params: Record<string, unknown>;
  state: TaskStateV2;
}
```

只读 tool result：

```ts
interface QueryDetailsV2 {
  schemaVersion: 2;
  kind: "query";
  action: "list" | "get";
}
```

query envelope 不含 `tasks/nextId`，replay 必须忽略。若 renderer 只需要 `content`，可直接省略 query details。

Reset custom entry 保存与 `MutationDetailsV2.state` 相同的版本化 checkpoint，并有独立 custom type，例如 `pi-todo-state`。

### Replay

replay 按当前 branch 的时间顺序处理：

- 接受旧 V1 Todo tool-result 快照；
- 接受 V2 `kind:"checkpoint"` tool result；
- 忽略 V2 `kind:"query"`；
- 接受用户 reset custom checkpoint；
- 最后一个合法 checkpoint 胜出；
- 非法或未知版本 envelope 跳过；
- 返回 fresh state，不共享引用。

`session_start/session_compact/session_tree` 继续使用相同 replay 入口。

### Batch 原子性

rollover 判断属于顶层 mutation 前置步骤，必须纳入 batch 的原子结果：任一 operation 失败时，rollover 与全部 operations 一起回滚。

### 为什么不做 delta

自动 rollover 使 live state 有界，mutation-only checkpoint 去掉只读重复写入。此时全量 live-state checkpoint 仍具有：

- 恢复简单；
- branch 语义清晰；
- 局部损坏可回退上个合法快照；
- 跨版本迁移成本较低。

只有基准证明 checkpoint 仍占显著体积或 replay 时间时，才考虑 delta。

## Guidance 调整

模型 guidance 应增加：

- 新周期必须用至少含两条 create 的原子 batch 按预期执行顺序启动；空/终态下顶层 create 或单项 create batch 会被 runtime 拒绝；
- 顶层 create 仅用于向已有活动多任务周期末尾追加后来发现的里程碑；
- Todo 是当前串行执行焦点，不表达依赖图、并发批次或长期可追溯方案；
- 周期后续只剩一项未完成或可见任务是正常状态，不得补充填充项；
- 默认 `list` 只返回 active tasks，completed 按 status 显式查询；
- 所有任务终态后，使用规定的 multi-create batch 开启下一周期，runtime 在 batch 前自动 rollover；
- rollover 后旧周期离开 live state，`list/get` 不可查询，只能从 transcript/tree 查看；
- 不尝试调用 reset/clear；
- 每次 agent run 的 `Current Todo state` 及后续 update 是当前 live state 真相，后者优先；
- 新目标到来但当前仍有活动任务时，不静默删除旧任务；根据用户意图继续、requeue、delete 或询问。

## 验收标准

1. `list/get` tool result 不包含 replay checkpoint，也不复制完整 tasks。
2. replay 忽略 query envelope，并兼容 V1 快照。
3. 所有任务终态后，下一次合格的多 create batch 原子 rollover；旧任务不进入新 checkpoint。空/终态顶层 create 与单 create batch 失败且不改状态。
4. batch 中途完成最后任务再 create 不触发第二次 rollover。
5. rollover/reset 后 `nextId` 不下降，task ID 不复用。
6. 默认 list 只输出 pending/in-progress，并准确报告隐藏 completed 数量。
7. status-filtered list 仍能查询当前周期 completed/deleted。
8. model-facing schema 不包含 clear；旧 V1 clear 快照仍可 replay。
9. `/todo` reset 有确认、活动任务警告，并通过 branch-scoped checkpoint 持久化。
10. reset 后 reload/tree 恢复正确状态，widget 立即消失。
11. 每次 agent run 有 active task 时，最终模型 system prompt 包含短 `Current Todo state`；无 active task 时不包含。
12. active 摘要不包含 description、metadata、deleted 或旧周期任务。
13. compact/resume/tree 后的下一次 agent run 获得恢复后的精确 active 摘要。
14. model-facing schema、live state、输出、widget 和 guidance 均不包含依赖图字段或行为。
15. 旧 checkpoint 中的额外历史字段被兼容读取但不进入新 live state。
16. 现有单 in-progress、batch rollback 与 overlay 生命周期测试继续通过。

## 价值验证

实施后必须补两个基准/行为 fixture：

### JSONL 增长

脚本化执行多个周期，每周期创建、查询、更新 5 个任务，对比：

- Todo tool-result `details` 总字节数；
- 整个 session JSONL 字节数；
- replay 时间。

结论需同时报告 Todo 占整 session 的比例，避免把结构性优化夸大成整体性能收益。

### Compact 后行为

构造一个 in-progress 与后续 pending 任务，经历一次或多次 compact 后继续执行，验证模型可见上下文包含精确 ID/status/subject 和自然顺序。若可稳定执行模型级回归，再比较是否减少重复 create、错误 update 或偏离当前焦点；否则至少对 system prompt 构造做确定性契约测试。

## 明确删除的完整方案内容

本期不做，且实现任务不得顺手加入：

- 显式 Plan/currentPlan 状态；
- planGoal、planId UI；
- close_plan 与 completed/superseded/cancelled outcome；
- archive envelope 或完整任务归档；
- history list/get；
- 多 Agent owner/claim 模式；
- 依赖图、并发批次或调度 DAG；
- delta/event sourcing。
