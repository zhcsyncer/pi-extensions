# pi-tool-display-intent 聚合布局设计

## 状态

已实施，当前处于本地试用与发布前验证阶段。

最终定义：

> `aggregate` 是按 user turn 汇总所有已注册工具的有界 `Tools` 视图。它只改变交互渲染，不改写工具执行、Session call/result 或模型历史上下文；不推断文件变更，不展示逐工具 output/diff body。`Agent` 默认保留原 renderer，图片结果 fail-open。

`individual` 完整保留原有逐工具行为。layout 切换在 `/reload` 后按当前 branch 重绘全部历史，而不是只影响未来调用。

## 目标

- 一次用户请求中的 built-in、custom、MCP 和延迟加载工具统一计数。
- Tools 首行直接展示每类工具的总调用次数和失败总数。
- 当前工具显示确定性 target；无法可靠提取 target 的 custom tool 只显示名称。
- 成功行用 `✓` 表示，由下一调用替换；最终成功行在 agent settled 后延迟收起。
- 收起时错误只显示总数；夹在工具之间的中途旁白默认隐藏，最终结论仍可见。
- `Ctrl+O` 后离开 Tools 账本，中途文字按原时间线插回，每条调用各自显示一行目标/状态概要。
- thinking 不是旁白，也不进入展开边框；aggregate 剥掉收起的 `Thinking...` 占位和 thinking 正文，但不隐藏错误。显式展开且没有最终 text 时，reasoning 仍可单独查看。
- 原始 tool call/result 保持可恢复；切回 individual 后原 renderer 重新展示历史详情。

## 非目标

- 不展示 read/bash/custom output、文件正文或 diff body。
- 不计算文件数、`+A/−B` 或所谓“本轮净变更”。父 Session 无法完整观察 Bash、custom tool 和子 Agent 的文件副作用。
- 不生成组合 intent，不让模型额外解释工具阶段。
- 不根据工具名猜测“分析中、实现中、测试中”等过程语义。
- 不让颜色成为唯一信息通道；名称、计数和状态符号始终保留。
- 不复制 GPLv3 `pi-compact-display` 实现。

## 心智模型

```text
用户消息             目标：为什么做
assistant 普通文字   进展：发现了什么
Tools                审计：调用了哪些工具、当前在做什么、是否失败
```

Tools 是整轮总览，不是一段必须连续的时间线。passthrough 工具可以保留独立行，同时仍计入总览。

## 分组边界

一个 group 从一条**新请求** user message 开始。同一请求内的多个 assistant/tool 低层 turn，以及插在 tool 批次之后的 **steer**，属于同一 group。follow-up 和闲时新提问才开下一本账。

```text
user
  assistant + tools
  results
  ↳ steer（不断 group）
  assistant + tools
  results
  assistant final response
```

assistant 普通文字、thinking、custom tool 和 passthrough tool 都不切断 group。steer 也不切断。调用按 assistant source order 记录；同一 tool call id 的 streaming message update 不重复计数。

Steer 的展示契约见 [`aggregate-steer.md`](./aggregate-steer.md)：进行中钉首行、结束后标题下留一行 `↳ N steers`、展开后 `↳` 留在时间线中间并整行高亮，不把正文拼进第一条 user，标题括号里不再重复计数。

## 两层模型

### 调用账本

所有工具都进入调用账本：

```text
pending / running / success / failed / needsAttention
```

账本负责：

- 每种工具的总调用次数；
- 首次出现的稳定展示顺序；
- 全局 failed 数；
- 每类工具的 last deterministic target；
- reload/tree/compaction 后从当前 branch 重建。

计数包含 pending、running、success、failed 和 needsAttention，不把 `×N` 伪装成“成功次数”。

### 聚合渲染成员

默认所有工具的 transcript renderer 都被 Tools 投影接管。以下工具仍进入账本，但不成为聚合 leader，也不生成 active/done 行：

- `tools.passthrough` 中的工具；
- 运行时返回图片的工具。

`Agent` 是默认 passthrough，因为其前台进度、步骤和结果 renderer 具有独立价值。若本轮只有 passthrough/image 工具，没有可承载 Tools 的 leader，则不额外制造空 summary 行。

## 展示行为

### 首行

```text
◐ Tools (16 calls · 3 turns) · read ×12 · ask_user_question ×1 · edit ×8 · bash ×16
```

失败时：

```text
! Tools (31 calls · 4 turns) · 2 failed · read ×12 · web_search ×3 · bash ×16
```

规则：

- 标题固定为 `Tools`；
- 不显示 `N running`，当前行已经提供更具体的信息；
- failed 放在工具计数之前，避免窄窗口先截掉异常状态；
- 工具类型按首次出现顺序稳定排列；
- 每个工具名使用确定性的主题颜色，不对 edit/write 做特殊语义分组。

### 当前与 done 槽位

```text
◐ Tools (16 calls · 3 turns) · read ×12 · bash ×16
  › 先对照两边入口
  ◐ Bash(pnpm test)
```

整轮结束后：

```text
✓ Tools (17 calls · 3 turns) · read ×12 · bash ×17
  took 2m14s · tok ↑62k ↓8.4k R120k W4.1k · at 2026-04-08 14:32:14
```

- 最多显示 3 个 active/recent-done 行；
- running/pending 优先占槽位；
- 新调用替换最早保留的 done；
- retained done 总数硬限制为 3，隐藏旧行不得稍后回弹；
- agent settled 后最终 done 保留 1.5 秒再收起；
- 新工具出现会取消旧的 settled 计时；
- done 仅是实时 UI 状态，历史重建不恢复；
- 进行中的 `›` 旁白走 Markdown，最多 3 行；标题、列表、代码块也算进这 3 行，不把账本撑开；
- 没有 Tools 账本时，最终回答保留与 user 之间的空行；只有账本已经留下底空时才去掉，避免叠两行。

### 错误

收起视图只显示 `N failed`，不逐条堆叠常见 tool error。passthrough 工具的原 renderer 自己负责错误详情，但失败仍计入首行。

### 展开

`Ctrl+O` 离开 Tools 账本，并按原时间线恢复中途旁白和逐条调用概要：

```text
✓ Tools (3 calls · 2 turns) · read ×1 · bash ×1
  took 2m14s · tok ↑62k ↓8.4k R120k W4.1k · at 2026-04-08 14:32:14
  │ › 先定位两边的设计与实现入口，再对照分组、渲染和边界。
  │ ✓ Read(src/index.ts)
  │ › 先把两边的设计文档和关键实现读清楚。
  │ ! Bash(pnpm test): 1 test failed
  └ ✓ ask_user_question
```

- 汇总条留在框外，没有边线；
- 中途 assistant 文字回到原来的位置，不重排到 Tools 前后；
- 展开内容共用一条贯通边线：中间行 `│`，同一 group 只有一条 `└`；
- 展开只框工具调用和中途 text；thinking 不标 `›`、不进框；最终结论区留在框外；
- 旁白行用 `›` 与工具概要区分；进行中收起账本把最新旁白钉在汇总头下方、工具行上方，整轮结束后再全部收起；
- 有 deterministic target 时显示目标；
- generic custom tool 不猜参数含义，只显示名称；
- 失败行附带一行错误摘要；
- 不恢复 raw output、文件列表或 diff body。

要检查原始详情，切回 individual：

```text
/tool-display-intent layout individual
/reload
```

## Custom 与交互工具

Aggregate 默认收起 custom tool 的 transcript call/result，但不修改 `execute()`：

- `ctx.ui.custom()`、dialog、overlay、widget、外部 pane 等执行期 UI 继续工作；
- 例如 `ask_user_question` 的问卷仍会临时替换 editor；完成后的答案 renderer 在 aggregate 中收起；
- 原始答案仍在 tool result 中，切 individual + reload 后重新可见；
- custom tool 的 schema、prepareArguments、execute 和原 renderer definition 均不被改写。

需要持续查看原 renderer 的工具加入 `tools.passthrough`。passthrough 工具仍计入 Tools；只是不被零行隐藏。

## 图片 fail-open

任意工具结果包含 image block 时：

1. member 转为 `needsAttention`；
2. 原 `ToolExecutionComponent` renderer 和图片组件恢复；
3. leader 重新选择最新非 passthrough、非 needsAttention 工具；
4. 图片调用仍保留在工具计数中。

Aggregate 不用文本统计替代图片。

## Session 与上下文

聚合投影不改写或追加：

- user/assistant messages；
- tool call arguments；
- tool results；
- reasoning；
- 文件变更统计 custom entry。

投影按 session / ExtensionAPI 隔离，不存在一份可被后来者覆盖的进程级绘制账本。同进程后加载的 Explore、另一个 pane 或 `/btw` 可以有自己的账本，但不得抢走宿主 TUI 正在使用的投影指针，也不得用自己的 branch 重建宿主账本。没有独立 TUI 的子会话不接管全局 renderer patch。`session_shutdown` 只清自己的账本，未到最后一个存活实例时不得卸掉宿主补丁。

本扩展不再给 thinking 正文加 `Thinking:` 展示前缀，也不再为此改写 session 或在 `context` 事件里回剥标签。旧配置里的 `transcript.thinkingLabel` 按未知字段丢掉。

投影只存在于当前扩展运行时，并从所属 Session branch 重建。Custom tool 原 result 因此可在 individual 恢复。

本扩展持有的 built-in 在 aggregate 下不注册 `displaySummary`，所以未来模型调用不会为这些工具生成 intent；这改变未来 tool schema，不改变已有历史消息。Interactive Tools 补丁不参与 HTML export，HTML 使用当前注册工具的原 renderer。

## 渲染机制

Pi 的 `getAllTools()` 只提供 ToolInfo，不能安全取得并重注册其他扩展的 execute/schema/renderers。为了覆盖 early、late、custom 和 MCP tool，aggregate 使用 Pi 导出的 `ToolExecutionComponent` 做 reload-safe render prototype patch：

```text
latest eligible component -> Tools lines
other aggregated members  -> []
passthrough/image          -> original render()
```

工具 definition 保持原样，因此：

- individual reload 可以直接恢复；
- custom execute/schema 不会因所有权重注册而丢失；
- late tool 无需发现或二次包装；
- HTML exporter 不受 interactive component patch 影响。

补丁使用全局 Symbol 保存原 render，reload 时恢复；若后加载扩展包裹该 renderer，则停用本层而不制造递归包装。

## 配置

```text
toolCalls.layout:
  individual  原有逐工具布局，默认
  aggregate   全工具有界 Tools 总览
```

`tools.passthrough` 接受任意非空、无首尾空白的工具名。默认有效列表包含 `Agent`，稀疏序列化时省略。内置 passthrough 名称同时关闭本扩展在 individual 中对该 built-in 的 renderer override。

Aggregate 下 individual-only 配置保留但不生效，设置 TUI 隐藏这些项；切回 individual 后恢复原值。

## Branch 重建

`session_start`、`before_agent_start`、`session_tree`、`session_compact` 都从：

```text
ctx.sessionManager.getBranch()
ctx.sessionManager.buildSessionContext()?.messages
```

重建当前 branch 的 group、counts、failures 和 leader。原 branch 中的 tool calls/results 是真源；不存在第二份聚合 Session 结构。

## 验收标准

1. 未声明 layout 时 individual 行为完全不变。
2. Aggregate 统计所有 built-in/custom/MCP/late tool，重复 streaming update 不重复计数。
3. `×N` 是总调用次数，failed 单独计数；收起不显示逐条错误。
4. Tools 最多显示 3 个 active/recent-done，done 替换和 settled 延迟无回弹。
5. `Ctrl+O` 离开 Tools 账本，按原时间线恢复中途旁白和逐条调用概要，不泄露 raw output/diff/file summary。
6. 不生成、保存或恢复任何 aggregate 文件变更统计。
7. `Agent` 默认保留原 renderer但仍计数；任意配置 passthrough 同样处理。
8. `ask_user_question` 交互正常，aggregate 隐藏完成结果；individual + reload 恢复答案。
9. 图片结果 fail-open，unknown/custom 普通文本工具默认聚合。
10. 非 leader 成员真实零高度，无 Spacer、空 Box 或背景行。
11. reload/resume/tree/compaction 后 counts、leader、failed 正确，瞬态 done 不恢复。
12. 聚合不改写 Session call/result，不向模型上下文注入 Tools 数据。
13. 收起的 `Thinking...` 占位、thinking 正文和中途旁白被隐藏；最终结论、错误保留。thinking 不当旁白，不进展开边框。
14. HTML export 与 individual 历史 renderer 保持可用。
