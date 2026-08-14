# pi-tool-display-intent 聚合布局设计

## 状态

方案已确认，待实施。

本方案为 `pi-tool-display-intent` 增加 `aggregate` 布局。最终决策是：

> aggregate 是固定最小化的 Activity 视图，不展示逐工具详情，不生成 intent，也不展开组内成员；当前运行工具直接显示在 Activity 节点内部，成功后自动收起。

现有逐工具展示完整保留为 `individual` 布局。两种布局共享一份配置文件，但 aggregate 下与逐工具详情有关的偏好暂不生效，并在配置 TUI 中隐藏；切回 individual 后恢复原值。

## 目标

- 一次用户请求中的工具调用合并为一条 Activity 统计，减少 transcript 噪音。
- Activity 内部持续显示当前运行工具的确定性目标，如路径、命令或查询。
- 工具成功结束后立即从 current list 消失并计入统计。
- 失败和需要用户处理的事件保持一行可见摘要。
- aggregate 下不因 `Ctrl+O` 展开整个长会话。
- 原始 tool call arguments、results 和 diff 数据仍保留在 Session 与模型上下文中。
- 旧配置、旧 Session 和默认行为保持不变。

## 非目标

- aggregate 不展示 read/bash 输出预览、完整命令、文件正文或 diff body。
- aggregate 不生成逐工具 intent 或组合 intent。
- aggregate 不提供 group-local 或 global member expansion。
- aggregate 不复用 `results.mode`、tool-call style、diff 或 expanded-row 细节渲染。
- 不根据 assistant 描述、intent、时间间隔或完成顺序猜测阶段。
- 不直接复制 GPLv3 的 `pi-compact-display` 实现。

## 心智模型

```text
用户消息                目标：为什么做
assistant 普通文字      进展：发现了什么、下一步是什么
Activity                状态：调用了什么、当前做什么、是否失败
```

Activity 是运行状态和审计统计，不重复解释用户目标。

## 分组边界

一个 Activity group 覆盖一次用户请求：从一条用户消息之后，到下一条用户消息之前。

同一用户请求内的多个 Pi 低层 turn 属于同一个 group：

```text
user
  assistant + tool calls
  tool results
  assistant + tool calls
  tool results
  assistant final response
```

中间 assistant 普通文字和 thinking 不切断 group，也不进入 Activity 内容。边界只依赖 user message/session 结构，不依赖自然语言分类。并行工具按 assistant source order 记录，不按完成顺序重排。

steer/follow-up 一旦形成新的 user message，就开始新的 group。

## Activity 节点与位置

Activity 不固定由第一个工具长期承载，而由当前 group 中**最新的 aggregate-safe 工具组件**承载：

1. 第一个可聚合工具出现时，它成为 leader 并显示 Activity。
2. 后续可聚合工具出现时，leader 转移到最新工具。
3. 旧 leader 与其他 settled 成员渲染为零行。
4. 当前 Activity 始终靠近 transcript 底部和正在执行的工具。
5. group 完成后，最终 leader 保留折叠统计，位于该 user turn 最后一批工具附近。

assistant 文字和不参与聚合的工具仍留在原时间位置，不被搬运或重排。

## 展示行为

### 执行中

```text
◐ Activity · read ×12 · edit ×8 · bash ×16
  Bash(pnpm test)
```

当前项只显示确定性信息：

```text
Read(src/index.ts)
Search(/renderCall/ in src)
Edit(src/group-view.ts)
Bash(pnpm test)
```

不显示模型 intent，也不显示运行输出。Pi 支持 parallel tools，因此 current list 最多显示 3 项，按 source order 排序；更多项显示：

```text
… 4 more running
```

显示项完成后，按 source order 补入下一项。

### 成功完成

```text
✓ Activity · read ×12 · edit ×8 · bash ×17
```

edit/write 必须尽量附带可确定计算的修改规模：

```text
✓ Activity · read ×12 · edit ×8 · 6 files · +184 −63 · bash ×17
```

算不出某项 stats 时只省略该项，不虚构结果。

### 失败或需关注

失败保留一行原因摘要：

```text
! Activity · read ×12 · edit ×8 · bash ×17 · 1 failed
  Bash(pnpm test): 1 test failed
```

审批、结构化提问、图片、等待输入和其他交互工具不进入 Activity，继续独立展示。未知、passthrough 或未声明 aggregate-safe 的 custom tool 同样保持自身 renderer。

### 状态分类

```text
pending       已产生 tool call，尚未 executionStarted
running       executionStarted，尚无 final result
success       final result 且非 error/attention
failed        final result isError，或恢复时确认已中断
needsAttention 交互、审批、图片或必须独立展示的结果
```

partial update 仍属于 running。Session idle 时历史 tool call 缺失 final result 不得计为 success，应显示 interrupted/failed。terminated、aborted、rejected 等终态在实现时映射为 failed 或 needsAttention，并写契约测试。

## 无展开行为

aggregate-owned 工具忽略 Pi 全局 `expanded`：

- `Ctrl+O` 不显示隐藏成员；
- `Ctrl+O` 不展开 Activity 内的结果；
- Activity 只保持固定最小视图；
- 非聚合工具仍保留自己的原生 `Ctrl+O` 行为。

因此 aggregate 不会把整个长会话的 settled tools 和完整输出一次性展开，也不存在 group renderer 与原工具 renderer 双重渲染。

需要审查原始工具详情时，用户切回 individual 并 reload：

```text
/tool-display-intent layout individual
/reload
```

Pi 根据 Session 中持久化的 tool calls/results 重建逐工具视图。aggregate 期间没有生成 `displaySummary`，因此恢复后的历史行只有确定性 target 和原始 result，不补造 intent。

未来可以新增独立 Activity inspector，但不属于第一版。

## 零高度隐藏与 aggregate 节点

第一版只聚合本扩展明确持有并标记 aggregate-safe 的工具。aggregate 布局下，这些工具统一使用 self shell：

```text
renderShell: "self"
```

渲染规则：

```text
latest leader  -> Activity component
other members  -> zero-row component
```

Pi 的 self-shell 在内容为空且没有 image component 时可以返回 `[]`，从而绕过默认 shell 的固定 Spacer 和空 Box。aggregate 不需要在 `Ctrl+O` 后恢复 default shell，因此不会与 individual shell style 冲突。

实施前必须完成 go/no-go spike，验证：

1. 非 leader 成员真实 `render(width) === []`，没有空行、背景或滚动占位；
2. leader 转移后旧 leader 立即归零，新 leader 正确刷新；
3. parallel update/completion 不重复计数；
4. reload/resume/tree 后能重建 leader 与 group；
5. image、interactive、passthrough 和 unsafe custom tool 不被静默隐藏。

任何 aggregate-safe 工具若不能满足零高度契约，就必须退出聚合、保持独立显示；不得以空 Box 冒充隐藏。

## 配置模型

新增唯一布局字段：

```json
{
  "$schema": "https://raw.githubusercontent.com/zhcsyncer/pi-extensions/main/packages/pi-tool-display-intent/config/config.schema.json",
  "version": 2,
  "toolCalls": {
    "layout": "aggregate"
  }
}
```

```text
toolCalls.layout:
  individual  原有逐工具布局，默认值
  aggregate   固定最小 Activity 布局
```

命令：

```text
/tool-display-intent layout individual
/tool-display-intent layout aggregate
```

切换 layout 会改变工具 Schema 和 renderer shell，保存后提示 `/reload`。

### 配置偏好保留

配置文件仍保留 individual 的全部偏好：

- `intent.*`
- `toolCalls.style`
- `toolCalls.bashCommandPreviewRows`
- `results.mode`
- `results.previewRows`
- `diff.*`
- `advanced.expandedRows`

aggregate 不修改、不删除这些值，只让它们暂时 inactive。切回 individual 后原值恢复。

### 配置 TUI 条件显示

TUI 始终显示：

- Tool call layout
- User message style
- Thinking label
- 其他与 transcript 或扩展通用行为有关的设置

当 layout 为 aggregate 时，主设置列表隐藏：

- Tool result mode
- Preview rows
- Model-written intent
- Tool call style
- Bash command rows
- Diff layout/indicator/collapsed settings
- Expanded rows

选择 individual 后立即重新显示这些 retained values。隐藏只影响 TUI，不删除 JSON 字段。`/tool-display-intent show` 仍报告 retained values，并标记 `inactive in aggregate layout`，用于诊断。

TUI 在 aggregate 模式显示说明：

```text
Aggregate uses a fixed minimal Activity view.
Individual-tool settings are retained but hidden.
```

## Intent 协调

```text
effectiveIntent = config.intent.enabled && toolCalls.layout === "individual"
```

aggregate 下不向 owned tool Schema 注入 `displaySummary`，避免隐藏内容继续消耗 token。切回 individual 后恢复用户原 intent 偏好。

## Aggregate-safe 边界

第一版内置白名单：

```text
read, grep, find, ls, bash, edit, write
```

仍受 ownership/passthrough 限制。custom tool 默认不参与；合作式 API 后续可增加显式 `aggregateSafe: true`，仅允许保证无交互入口、无必须常显 UI 的工具 opt in。

结果含图片或运行时判定需要关注时，即使工具名在白名单中，也不得把该内容静默隐藏；图片/attention 保持独立可见。

## 实现模型

聚合层维护一个 branch-aware、user-turn-scoped 的内存投影：

```ts
interface AggregateGroup {
  groupId: string;
  leaderToolCallId?: string; // latest eligible member
  members: AggregateMember[];
}

interface AggregateMember {
  toolCallId: string;
  toolName: string;
  sourceOrder: number;
  args: unknown;
  state: "pending" | "running" | "success" | "failed" | "needsAttention";
  errorSummary?: string;
}
```

数据来源：

- live：assistant message/tool execution events；
- final status：tool result；
- reload/resume/tree：当前 branch 的 assistant tool calls 与 tool results；
- render：leader component 动态读取投影；
- update：保存 leader 的 `context.invalidate`，group 状态变化时请求重绘。

原始 tool call/result 仍是状态事实来源。唯一例外是成功 `write` 的确定性 `+A/−B`：旧文件内容不会进入 tool result，reload 后无法重算，因此扩展只把已经算出的两个计数和 `toolCallId` 写为不可见 custom session entry；不保存旧内容、不修改原 call/result，也不进入模型上下文。若 `appendEntry` 不可用或写入失败，就省略历史 `write` 的该项统计，不猜测数据。

Pi 当前没有公开 transcript-level group renderer。若 public event + self-shell + invalidate spike 无法满足零高度与恢复契约，才考虑最小、隔离、可回滚的内部适配层或推动 Pi 正式 hook。不得复制 `pi-compact-display` 的 GPLv3 代码。

## 配置兼容

本次为 v2 additive change：

- 缺少 `toolCalls.layout` 时默认 `individual`；
- 旧配置、旧 Session 和 `/reset` 保持原行为；
- sparse serializer 只在选择 aggregate 时写入 `"layout": "aggregate"`；
- 不需要 schema version bump；
- layout 无效时回退 individual。

## 验收标准

1. 旧配置未声明 layout 时逐工具行为完全不变。
2. aggregate 只显示一个最新 Activity 节点、最多 3 个 current items 和失败摘要。
3. success 完成后立即从 current list 消失并准确计入统计。
4. 非 leader aggregate members 为真实零高度，无 Spacer、空 Box 或背景行。
5. 新成员出现时 leader 转移到最新成员，旧 leader 归零且 Activity 保持靠近 transcript 底部。
6. parallel tools 按 source order 展示，乱序完成不重复计数。
7. 中间 assistant 文字正常展示且不切断同一 user-turn group。
8. aggregate 不注册 `displaySummary`，不生成组合 intent，也不产生额外推理调用。
9. aggregate-owned tools 忽略 `Ctrl+O`，长会话不会因展开泄洪；非聚合工具保持原行为。
10. edit/write 折叠统计包含可确定的 file/diff stats。
11. error、aborted、interrupted、approval、question、image 和 unsafe custom tool 不被计为普通 success 或静默隐藏。
12. reload/resume/tree/compaction 后 group、leader、统计和错误状态正确。
13. aggregate TUI 隐藏 inactive detail settings，但 retained values 不变；切回 individual 后完整恢复。
14. `/tool-display-intent show` 准确区分 effective 与 retained settings。
15. layout 切换触发 `/reload` 提示，individual 重建历史工具详情且不补造 intent。
