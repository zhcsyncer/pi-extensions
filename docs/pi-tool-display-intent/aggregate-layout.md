# pi-tool-display-intent 聚合布局设计

## 状态

已实施，当前处于本地试用与发布前验证阶段。

最终定义：

> `aggregate` 是按 user turn 汇总所有已注册工具的有界 `Run` 视图。它只改变交互渲染，不改写工具执行、Session call/result 或模型历史上下文；不推断文件变更，不在账本时间线展示逐工具 output/diff/image body；用户点击工具行时可在只读弹窗检查文本结果。Agent 与 consult 默认同样聚合。

`individual` 完整保留原有逐工具行为。layout 切换在 `/reload` 后按当前 branch 重绘全部历史，而不是只影响未来调用。

## 目标

- 一次用户请求中的 built-in、custom、MCP 和延迟加载工具统一计数。
- Run 首行直接展示每类工具的总调用次数和失败总数。
- 当前工具显示确定性 target；custom tool 优先用 `getCallPresentation`，否则只选一两个有辨识度的值，不展示键名。大载荷、控制参数、对象形状与敏感值不进入预览，完整键值留在详情。
- 成功行用 `✓` 表示，由下一调用替换；最终成功行在 agent settled 后延迟收起。
- 收起时错误只显示总数；夹在工具之间的中途旁白默认隐藏，最终结论仍可见。
- `Ctrl+O` 后离开 Run 账本，中途文字按原时间线插回，每条调用显示有界目标/状态概要。
- thinking 不是旁白，也不进入展开边框；aggregate 剥掉收起的 `Thinking...` 占位和 thinking 正文，但不隐藏错误。显式展开且没有最终 text 时，reasoning 仍可单独查看。
- 原始 tool call/result 保持可恢复；切回 individual 后原 renderer 重新展示历史详情。

## 非目标

- 不在账本时间线展示 read/bash/custom output、文件正文、diff body 或图片像素。按需查看走只读弹窗，不复刻自定义交互 renderer。
- 不计算文件数、`+A/−B` 或所谓“本轮净变更”。父 Session 无法完整观察 Bash、custom tool 和子 Agent 的文件副作用。
- 不生成组合 intent，不让模型额外解释工具阶段。
- 不根据工具名猜测“分析中、实现中、测试中”等过程语义。
- 不让颜色成为唯一信息通道；名称、计数和状态符号始终保留。
- 不复制 GPLv3 `pi-compact-display` 实现。

## 心智模型

```text
用户消息             目标：为什么做
assistant 普通文字   进展：发现了什么
Run                审计：调用了哪些工具、当前在做什么、是否失败
```

Run 是调用与可见扩展消息的展示投影，不是新的 Session 消息。passthrough 工具可以保留独立行，同时仍计入总览；原生内容按账本缩进排版。custom message 则留在原消息位置参与开合，不追溯后台任务身份、不重排到派发调用旁。

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

`display: true` 的 custom message 在当前位置进入 group，独立计为 messages，不伪造工具调用、成功状态或模型 turn。最终回答仍在账本外；其后的通知另起可折叠段，避免把先前摘要移到回答下方或让框线跨过回答。连续闲时通知可共用一段，即使没有工具也有摘要入口。`display: false`、普通 custom entry、widget、临时通知不进入这条展示链路。消息内容与模型上下文是否可见不受折叠影响。

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
- reload/tree/compaction 后从宿主实际选中的、已考虑压缩的上下文条目重建。

计数包含 pending、running、success、failed 和 needsAttention，不把 `×N` 伪装成“成功次数”。

### 聚合渲染成员

默认所有工具的 transcript renderer 都被 Run 投影接管。`tools.passthrough` 中的工具仍进入账本，但不成为聚合 leader，也不生成 active/done 行。

默认没有 passthrough，Agent 与 consult 都收进统一调用行；实时子任务 UI 继续由 subagents 自己提供，不在账本复制进度，也不修改该扩展。若用户显式配置后，本轮只有 passthrough 工具、也没有可见 custom message，没有可承载 Run 的 leader，则不额外制造空 summary 行；工具前的旁白按普通 assistant 文字渲染，不收成 user 下方的 `›` 框。有 leader 时，夹在工具之间的中途旁白才折进账本。

## 展示行为

### 首行

```text
◐ Run (16 calls · 3 turns) · read ×12 · ask_user_question ×1 · edit ×8 · bash ×16
```

失败时：

```text
! Run (31 calls · 4 turns) · 2 failed · read ×12 · web_search ×3 · bash ×16
```

规则：

- 标题固定为 `Run`；
- 不显示 `N running`，当前行已经提供更具体的信息；
- failed 放在工具计数之前，避免窄窗口先截掉异常状态；
- 工具类型按首次出现顺序稳定排列；
- 每个工具名使用确定性的主题颜色，不对 edit/write 做特殊语义分组。

### 当前与 done 槽位

```text
◐ Run (16 calls · 3 turns) · read ×12 · bash ×16
  › 先对照两边入口
  ◐ Bash(pnpm test)
```

整轮结束后：

```text
✓ Run (17 calls · 3 turns) · read ×12 · bash ×17
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
- 每条调用收起最多 2 行；过长 target 在耗时左侧换行，首行继续把耗时靠右；
- 进行中与展开行右侧显示这条的耗时；结束后再加时分秒。整轮收据仍是 `took … · at …`；
- Bash 的完整括号目标必须能放进一个实际标签行（扣除缩进、状态和耗时）；超宽或多行就整体隐藏命令，保留 Bash、intent 和体积，不截断或换行拼半个括号。完整脚本走详情查看器；
- 没有 Run 账本时，最终回答保留与 user 之间的空行；只有账本已经留下底空时才去掉，避免叠两行。

### 错误

收起视图只显示 `N failed`，不逐条堆叠常见 tool error。passthrough 工具的原 renderer 自己负责错误详情，但失败仍计入首行。

### 展开

`Ctrl+O` 离开 Run 账本，并按原时间线恢复中途旁白和逐条调用概要：

```text
✓ Run (3 calls · 2 turns) · read ×1 · bash ×1
  took 2m14s · tok ↑62k ↓8.4k R120k W4.1k · at 2026-04-08 14:32:14
  │ › 先定位两边的设计与实现入口，再对照分组、渲染和边界。
  │ ✓ Read(src/index.ts)                         0.3s  14:32:01
  │ › 先把两边的设计文档和关键实现读清楚。
  │ ! Bash(pnpm test)                            3.1s  14:34:02
  │   1 test failed
  └ ✓ Bash — 把策略固化成 zone · 54 lines · 2.3KB  8.4s  14:33:11
```

`toolCalls.expandedTimeline` 默认 `flat`，即上面这张逐条时间线。设为 `turns` 后，同一拍的调用收进拍头，时间挂在拍上，调用行缩进；旁白仍插在原位置。收起 Run 不变，切换不用 reload：

```text
✓ Run (8 calls · 3 turns) · read ×3 · edit ×2 · bash ×1
  took 2m14s · tok ↑62k ↓8.4k · at 2026-04-08 14:32:14
  │ › 先定位入口
  │
  │ ↻ 1/3 · 3 calls · 1m52s  14:13:45
  │   ✓ Read(a.ts)
  │   ✓ Read(b.ts)
  │   ✓ Search(pattern)
  │ › 对照两边实现
  │
  │ ↻ 2/3 · 2 calls · 19s  14:14:04
  │   ✓ Edit(a.ts)
  │   ✓ Edit(b.ts)
  │
  │ ↻ 3/3 · 1 call · 8s  14:14:12
  └   ✓ Bash — 跑测试 · 12 lines · 400B
```

拍时间是这一条 assistant 消息发出工具到这批结果写完的墙钟，不是每条 execute 的耗时。

- 汇总条留在框外，没有边线；
- 中途 assistant 文字回到原来的位置，不重排到 Run 前后；
- 展开内容共用一条贯通边线：中间行 `│`，同一 group 只有一条 `└`；
- 展开只框工具调用和中途 text；thinking 不标 `›`、不进框；最终结论区留在框外；
- 旁白行用 `›` 与工具概要区分；进行中收起账本把最新旁白钉在汇总头下方、工具行上方，整轮结束后再全部收起；
- 有 deterministic target 时显示目标；custom 优先用 presentation，否则显示有界参数预览。只有 bash 用模型写的 `displaySummary` 当 intent，其它工具不用；
- 调用概要最多 8 行；过长 target 换行后以 `…` 收口；
- 失败详情另起缩进行，最多 2 行，并计入调用概要的 8 行上限；
- 不恢复 raw output、文件列表、diff body 或图片。

Fullscreen 中点击展开后的工具行可检查参数和返回文本；需要原生 renderer 的图片或专用交互时，切回 individual：

```text
/tools individual
```

## 局部开合与详情查看

收起的 Run 内容区是同一点击目标，包括统计收据和当前调用预览；展开后整个标题／统计摘要区可点击收起。上下留白、展开后的旁白正文不变成开关，工具行保留详情入口，避免开合与检查内容冲突。局部点击只改变这一 run，工具、旁白、steer 共用其开合状态；Ctrl+O 是全局命令，覆盖局部选择。新工具应继承所属 run 的局部选择，而不是用原生组件初始化的全局值把它冲掉。同一 branch 的重建保持局部选择；reload 不保存新的 Session 状态。

Pi 0.85 的工具鼠标区域属于原生子组件布局，不能直接复用在自绘账本上：default/self shell 的行偏移和高度都可能失配，而且原生点击只切单个组件。聚合层只使用本次实际渲染的行范围处理点击；展开后标题宿主可以从工具移到旁白或 steer，入口必须随之移动。只消费普通左键 click，不接管 press/drag，也不把点击投给已经失配的原生子树；passthrough 保留原生交互，但以账本内容缩进后的宽度进行原生排版；仅将实际正文区域的坐标换算后交回原生子树，绝对屏幕坐标保持不变，使点击、焦点和拖动捕获继续命中原组件。左侧留白不接收点击，过窄窗口不保留旧命中区。

局部开合按账本身份保留标题锚点，不按承载组件或标题文字定位：展开后标题可能从工具组件迁移到更早的旁白组件，不同账本也可能有相同标题。锚定只在原生布局已有完整测量结果之后调整滚动，并退出跟随末尾；不为找位置再次渲染正文。兼容层拿不到可靠几何信息时，保留已有局部开合，不猜位置。

共享渲染钩子归 UI 宿主管理，而不是由残留子会话的数量决定是否释放。工具、旁白与视口的共享钩子只在有 UI 的会话启动时安装，所有 session_shutdown 都释放自身投影。reload 后模块位置表和订阅是新的、Pi 类却仍共享；因此跨模块必须移交渲染分发，并阻止旧模块晚到的清理破坏新绑定。工具与旁白保留可更新的分发入口，以免绕过其他扩展已包在外面的 renderer。

当展开账本的标题已滚出视口上方，而正文仍在阅读区域时，编辑器上方的 widget 组顶部显示靠右的当前账本收起条，左侧留白不参与点击。Pi 没有 widget 优先级选项；兼容层只在原生组合时提前本扩展的条目，不改变其他 widget 的相对顺序、底部 widget 分组或原始 Map，也不重新创建别人的组件。排序注册使用可释放的占用记录，旧会话晚到的释放不影响新会话。它是普通 widget，不进入 overlay 栈：Pi 的非抢焦点 overlay 仍会影响滚动条、选择和模式切换，不能只靠 `nonCapturing` 避免这些副作用。收起条不覆盖正文、不抢焦点、不切换全局展开状态；会话／分支更换、弹窗或退出 fullscreen 时撤销失效入口。显隐会改变输入区高度，因此选择状态不能再由这次布局调整反向决定，否则在 follow-end 时形成显示／隐藏反馈循环。仅用户实际导航、终端尺寸或文档／账本范围变化重新评估；纯计时或同高度文字更新不触发重判，不用定时器或永久空白槽掩盖抖动。

展开工具行打开统一只读快照查看器，而不是把完整原生 renderer 搬进时间线：任意扩展 renderer 可能依赖执行期状态、图片协议或交互生命周期，强行复刻会扩大兼容面。参数／元数据保留结构和原值，不做凭据脱敏；结果保留文本或 JSON；非文本附件只显示信息。窗口自身有滚动、自动换行和明确的安全截断，不调用工具、不添加消息、不影响模型上下文。

成功 Edit 的 Result 就是 diff，不另设 Diff 页；它复用本扩展已有的纯 diff 排版，而非调用工具自己的 renderer。弹窗跟随全局 diff 布局、标记和换行配置，aggregate 的设置面板也暴露布局／标记；行号与续行由 diff 排版负责，不再经过普通文本二次换行。Edit 只接受实际返回的 diff。Write 展示已成功写入的内容，以全新增表示且明确不是覆盖差异；它没有可供比较的旧正文，因此固定单栏，不跟随全局分栏选择，仍保留全局标记与换行配置；使用带行号的规范化记录避免源代码中的数字／`++` 被误认成 diff 元数据。失败优先原始错误，不读取当前文件伪造历史改动。

查看器只把 Result／Args 放在主标签中；工具额外返回的 Metadata 属于诊断层，收在 `⋯` 后，避免和主要结果抢位。Args 的键值/文本块来自同一份有界 JSON 快照，不再次访问工具对象；Raw 只是显示形式切换，所有视图均保留凭据原值，但终端控制过滤与工作量限制不取消。多行 command 不因 JSON 转义后变成一条长字符串就丢掉高亮视图；Shell 高亮只作用于 Bash 的 command 字段。明确的自定义 Markdown 及从 Markdown 文件路径读取的内容进入真正的 Markdown 排版，其他源码与日志不根据标点擅自解释。状态与耗时靠右，滚动位置固定在底栏右侧；只提示真实截断，不重复说明只读。

长 steer 使用终端显示行数而非源码换行数：≤8 行完整显示，超出后保留头3尾2，中间一行提示省略数量。头尾比模型摘要更适合保留原话和末尾约束；查看需求通过同一只读窗口满足，不让 Ctrl+O 意外展开无限高日志。

## 上下文增长的口径

`ctx` 的目标是定位让上下文膨胀的步骤，不是展示又一份当前水位或计费账。默认关闭，用一个开关控制收据总计和 `turns` 拍头；不在工具行分摊，因为父请求没有逐工具结果的真实 token 计数。启用时，展开拍头只编号有工具调用的拍；没有 toolCall 的普通回复不承载 ctx，即使它是工具 run 的最终回答。最终模型用量仍计入 run 总计。仅透传工具的拍可用轻量尾注；没有工具 leader 时不制造空 Run 框。

**测量点晚于归属点**：A 的工具结果只有进入 B 的请求后，才能从 B 的实际输入计数观察到。相邻完整、同模型的请求输入差值回填 A；缓存命中仍占上下文。未确认末拍用输出用量加自己的工具结果估算，始终标 `≈`；run 总计只加每拍贡献一次，有估算就保留 `≈`。输出包含 reasoning，但下次请求可能不原样回放，因此不能把报告的 output 当成精确上下文增长。

无 `≈` 表示**实际请求输入差值**，不是因果隔离后的动作成本。Session branch 能发现插话、custom 消息、压缩和模型/思考配置变化，却不能恢复所有扩展的临时提示词修改或供应商转换。遇到已知边界不跨界相减；run 有缺口就显示 `ctx n/a`，不把局部加总伪装为完整净增。未知的请求转换仍可能影响差值，不能承诺逐动作精确归因。

使用 `turn_end` 的最终 branch，而不是 streaming usage 或 `tool_execution_end`：前者已经经过 message_end 的消息替换并持久化，后者可能尚不是最终上下文内容。历史也按同一分支顺序重建。中间请求 hook 的指纹无法证明后续扩展没有修改请求，因此不引入一套看似精确的快照机制；不写 Session 元数据、不保存第二份正文、不额外请求模型。

## Custom 与交互工具

Aggregate 默认收起 custom tool 的 transcript call/result，但不修改 `execute()`。没有 `getCallPresentation` 时，调用行按目的／目标优先挑选最多两个值，不把参数键名变成视觉噪音，也不机械拼接所有标量。用于控制执行和携带大正文的参数留到详情；inline 安全预览与不脱敏的详情窗口保持分离。

Agent 属于委派型调用：类型／任务描述形成短标题；成功返回的后台回执标为 dispatched，前台完成可以标成功，错误优先。只解释当前调用回执，不追踪或覆盖后台任务的后续状态；计时也是调用的执行区间，不冒充后台任务寿命。已有结构化回执比请求里的模式开关可靠，未知回执只标 returned。缺少稳定的专属 viewer 打开接口时保留通用详情，不侵入 subagents 私有状态。

- `ctx.ui.custom()`、dialog、overlay、widget、外部 pane 等执行期 UI 继续工作；
- 例如 `ask_user_question` 的问卷仍会临时替换 editor；完成后的答案 renderer 在 aggregate 中收起；
- 原始答案仍在 tool result 中，切 individual + reload 后重新可见；
- custom tool 的 schema、prepareArguments、execute 和原 renderer definition 均不被改写。

需要持续查看原 renderer 的工具加入 `tools.passthrough`。passthrough 工具仍计入 Run；只是不被零行隐藏。

## 图片当普通 output

交互贴图会写成 `/tmp/pi-clipboard-*.png`，user message 只有路径文本；模型用 `read` 读文件，tool result 才带 image block。像素是工具结果，不是 user 附件。

因此 image block 视为普通 read output：收进 Run 账本，显示 `Read(/tmp/pi-clipboard-….png)`，成功走 done 槽。不恢复 Kitty/iTerm 原图。要看图切回 individual。

## Session 与上下文

聚合投影不改写或追加：

- user/assistant messages；
- tool call arguments；
- tool results；
- reasoning；
- custom message 的 content、details 和 display；
- 文件变更统计 custom entry。

投影按 session / ExtensionAPI 隔离，不存在一份可被后来者覆盖的进程级绘制账本。同进程后加载的 Explore、另一个 pane 或 `/btw` 可以有自己的账本，但不得抢走宿主 TUI 正在使用的投影指针，也不得用自己的 branch 重建宿主账本。没有独立 TUI 的子会话不接管全局 renderer patch。`session_shutdown` 清理所属账本；共享补丁的寿命由 UI 宿主决定，不等待滞留的 headless 子会话。旧模块晚到的清理不得卸载新宿主补丁。

本扩展不再给 thinking 正文加 `Thinking:` 展示前缀，也不再为此改写 session 或在 `context` 事件里回剥标签。旧配置里的 `transcript.thinkingLabel` 按未知字段丢掉。

投影只存在于当前扩展运行时，并从所属 Session branch 重建。Custom tool 原 result 因此可在 individual 恢复。

本扩展持有的 built-in 在 aggregate 下只有 bash 注册 `displaySummary`；read/edit 等仍不生成 intent。这改变未来 bash schema，不改变已有历史消息。Interactive Run 补丁不参与 HTML export，HTML 使用当前注册工具的原 renderer。

## 渲染机制

Pi 的 `getAllTools()` 只提供 ToolInfo，不能安全取得并重注册其他扩展的 execute/schema/renderers。为了覆盖 early、late、custom 和 MCP tool，aggregate 使用 Pi 导出的 `ToolExecutionComponent` 做 reload-safe render prototype patch：

```text
latest eligible component -> Run lines
other aggregated members  -> []
passthrough               -> inset native render() + translated native mouse region
```

工具 definition 保持原样，因此：

- individual reload 可以直接恢复；
- custom execute/schema 不会因所有权重注册而丢失；
- late tool 无需发现或二次包装；
- HTML exporter 不受 interactive component patch 影响。

补丁使用全局 Symbol 保存可移交的分发器，reload 时恢复所属层；若后加载扩展包裹该 renderer，则停用本层而不破坏外层包装。

Custom message 保留原组件子树，只改变外层布局与命中坐标。Run 开合不调用原生 invalidate 或改写 renderer 的 expanded 选项，避免重建有状态按钮。原生控件返回的焦点与拖动捕获目标保持不变；独立 viewer 中的同消息副本不被接管。

Pi 的 idle custom message 会直接通知 UI，绕过扩展 message events，因此入口观察实际 `addMessageToChat`，历史按原生 replay 的出现次序绑定，不用文本或时间戳猜测。Pi 的 reload 又会先重建历史、再触发 session_start：UI 宿主激活时还要绑定已存在的消息组件。绑定借用同步、零内容的 widget factory 获取 TUI 引用，随即移除，不留下 widget 或抢焦点。旧树数量不匹配、宿主树不兼容或 replay 失败时撤销 custom 投影、保留原生展示，避免不存在的摘要宿主吞掉工具内容；后续原生 replay 再重新建立绑定。

## 配置

```text
toolCalls.layout:
  individual  原有逐工具布局，默认
  aggregate   全工具有界 Run 总览
```

`tools.passthrough` 接受任意非空、无首尾空白的工具名。默认有效列表为空，稀疏序列化时省略；旧配置中显式写出的例外仍保留。内置 passthrough 名称同时关闭本扩展在 individual 中对该 built-in 的 renderer override。

Aggregate 下 individual-only 配置保留但不生效，设置 TUI 隐藏这些项；切回 individual 后恢复原值。

## Branch 重建

`session_start`、`before_agent_start`、`session_tree`、`session_compact` 都从：

```text
ctx.sessionManager.buildContextEntries()
# 旧宿主缺少该能力时才回退 getBranch()
```

重建当前可见上下文的 group、counts、failures 和摘要宿主。压缩保留尾部的展开跟随宿主 sessionEntryToContextMessages，兼容显式保留条目的旧格式；不把已压缩移除的消息重新挂回 UI。原始条目仍是真源，不存在第二份聚合 Session 结构。custom 出现序号只用于当前展示上下文中的绑定，不持久化，也不合并相同内容；切分支或压缩后不把旧消息的局部展开状态套到新消息上。

## 验收标准

1. 未声明 layout 时 individual 行为完全不变。
2. Aggregate 统计所有 built-in/custom/MCP/late tool，重复 streaming update 不重复计数。
3. `×N` 是总调用次数，failed 单独计数；收起不显示逐条错误。
4. Run 最多显示 3 个 active/recent-done，done 替换和 settled 延迟无回弹。
5. `Ctrl+O` 离开 Run 账本，按原时间线恢复中途旁白和逐条调用概要，不泄露 raw output/diff/file summary。
6. 不生成、保存或恢复任何 aggregate 文件变更统计。
7. Agent 与 consult 默认进入统一账本；显式配置 passthrough 的工具保留原 renderer，但仍计数。
8. `ask_user_question` 交互正常，aggregate 隐藏完成结果；individual + reload 恢复答案。
9. 图片结果收进账本，不 fail-open；unknown/custom 普通文本工具默认聚合，并显示确定性 target。
10. 非 leader 成员真实零高度，无 Spacer、空 Box 或背景行。
11. reload/resume/tree/compaction 后 counts、leader、failed 正确，瞬态 done 不恢复。
12. 聚合不改写 Session call/result，不向模型上下文注入 Run 数据。
13. 收起的 `Thinking...` 占位、thinking 正文和中途旁白被隐藏；最终结论、错误保留。thinking 不当旁白，不进展开边框。
14. HTML export 与 individual 历史 renderer 保持可用。
