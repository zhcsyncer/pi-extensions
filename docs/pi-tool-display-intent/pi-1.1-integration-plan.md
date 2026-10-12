# Tool Display：Pi 1.1.0 统一渲染实施规格

状态：待 review，未实施。归属：[总计划](../pi-1.1-implementation-plan.md) W3/W4。依据：2026-10-10 21:59 的 main `f48a91b`、PR #149 `10ce0603`、PR #150 `3a84d176` 与精确 Pi 1.1.0 源码。

## Goal

统一跨扩展的工具展示，同时保住宿主执行、历史和导航契约；新增 codemode 不再成为另一套显示补丁。长历史的输入响应不能被未变化的预览反复布局拖慢。

不统一问卷/编辑器等所有自定义 UI；不替其他扩展改变工具权限或持久化格式。codemode 是可选接入：未加载/未启用时普通展示必须正常，不能为了注册 renderer 自动开启工具或改用户模式。

## Design：明确三种所有权

1. **显示**：用 `registerToolRenderer` 处理 call/result/shell；显式组合 `next()`，不假定自动逐字段合并。保留问卷、Agent、搜索等合作工具的专用内容，只统一入口、外壳、预算和标题约定。
2. **语义装饰**：Bash 的 `displaySummary`、参数清理和 Write 执行前旧内容捕获单独保留。仓内其他工具不自动添加意图字段；通用 helper 仅供外部主动接入。完整保留原定义，只替换确有需要的字段；透传第五参数 context，不能丢失 `outputSchema`、`constrainedSampling`、`prepareArguments`、`exposure`、`prepareLoadout`。
3. **跨消息投影**：aggregate、steer、用户消息、viewport/鼠标仍有独立职责；新 renderer API 不代表这些补丁都可删除。对没有公共替代的部分维持最小、可移交的 ownership。

原生 codemode 的 raw-JS schema/grammar 不变；不得为统一意图强加一个 JSON `displaySummary` 必填项。代码注释可作展示 fallback，但不作实际执行证据。

Bash 的既有 displaySummary 契约另行保留：codemode 脚本无需额外填此字段，现有 prepareArguments 可补 fallback，没有已确认的缺字段故障。重构须保住这条预处理链；不扩大字段范围、不直接放宽 schema，也不让显示字段传入底层执行。精确 1.1 的真实 loader 与直接/nested 调用仍待集成验收，不能把 helper 单测视为完整链路已通过。

### renderer 组合契约

- 真实的 built-in、custom、动态 MCP，以及未连接的历史工具都可选择 renderer；不得修改 `getAllTools()` 的元数据副本冒充修改真实定义。
- 不拦截本扩展自己的 `registerTool` 来发现其他扩展：每个扩展拥有不同的 API 实例。
- 完整传递 `showImages/durationMs/outputPad/state/lastComponent` 等宿主上下文；包装器状态与被委托组件状态分开，不能把外壳作为原生 renderer 的 `lastComponent`。
- `renderShell: self` 主动处理留白；default shell 不重复加 padding。纯显示变化不能改变工具执行或模型输入。
- individual 模式优先保留原生 codemode 的进度能力，避免再造 spinner；aggregate 按根调用展示。

## W3-A：关闭 #148，缓存两层重布局

现有 `preview-text.ts` 重做布局/着色，`tool-call-style.ts` 又重做结果外壳测宽/截断；只缓存其中一层不够。

- 按内容修订、宽度、展开状态、主题 appearance/revision 和配置失效。
- 每个组件只保留有界的当前布局，不按每个历史宽度建立无限 Map。
- 缓存键不能靠每帧重新全量序列化/哈希大结果生成；昂贵处理前先应用输入/结构预算。
- 内容更新、配置切换及 resize 后截断标记、可见文本保持正确。

**AC**：100、300 个已完成的文本工具在 warm 后反复重绘，不再对未变化内容重做完整布局/高亮/外壳处理；改变失效条件后结果正确；缓存不随重复重绘和历史宽度无限增长。

分别记录真实组件的重复重绘成本和端到端输入/退格延迟，覆盖 regular/fullscreen。目标是消除已确认热点，不承诺消除所有长会话延迟；不得以切换 aggregate/summary 作为修复。

## W3-B：替代 #149，根调用拥有嵌套展示

### 数据来源不得混用

| 来源 | 用途 | 限制 |
|---|---|---|
| execution events + `parentToolCallId` | live 的直接父链、状态和取消 | 子调用没有独立 TUI 组件，也没有独立 transcript 结果 |
| codemode `details.calls` | 原生进度/最终摘要，含工具及模型调用信息 | 使用 `args/running/cancelled` 等自己的字段；不是通用持久记录 |
| 外层消息 `nestedCalls` | 恢复、审计和有界执行记录 | 使用 `arguments/unfinished/complete` 等字段；无结果正文，可能缺项 |

1.1.0 的工具 renderer 收到的 result 主要是 `content/details`，不能假设拿到消息顶层 `nestedCalls`。通用最终记录在消息事件阶段附入；投影不能只处理 execution_end，也不能把三个来源直接拼接累计。

### 投影契约

- 实时沿直接父链找到根，支持孙调用及更深层级；只有根可拥有顶层组件/Run leader。
- 一次 codemode 是一个顶层调用。子操作可展开显示，不增加顶层调用数，也不把模型调用行算成工具调用。
- 以稳定调用身份去重，不以临时 `/?` ID、名称或脚本里出现的 `tools.*` 字面量推断实际次数。
- 运行、完成、部分失败、取消和外层失败分开。脚本成功捕获错误，不代表所有子操作成功。
- 恢复只显示真实保存的信息。缺结果正文时明确说明不可恢复，不重执行、不读取当前文件冒充历史结果。
- `complete:false` 显示“不完整/至少已记录 N 项”，不得显示为精确总次数；缺参数与未结束状态也分别表达。
- 至少遵守宿主记录预算：最多 256 次、单调用参数 8 KiB、总参数 32 KiB；展示预算可更小。compact、expanded、error、详情均受预算约束，并明确省略内容。
- 不先对任意大对象 `JSON.stringify` 再裁剪。复用安全快照/有界遍历；全文查看只指向真实存在的产物。

### 时间与用量

- 完成后的单工具耗时优先读取原生 `durationMs`；运行中和旧历史缺值不当零，保留必要实时计时。
- nested runner、execute、本轮 wall time 不是同一口径；并行工具不能简单累加成 Run 耗时。
- 用量由外层汇总结果进入账本，nested 行只作分解展示，不重复入账。
- HTML 的 1.1.0 自定义 renderer 仍可能收到 `durationMs: undefined`、默认 outputPad；不得承诺与 TUI 完全相同。

## W4：联合解决 #150 与 #151

### 产品规则

新增 `transcript.userMessageBox: boolean`，默认 true。只控制**普通用户消息**的样式归属，不恢复多视觉主题，不控制 aggregate steer 是否折叠。

路由顺序：

1. 先识别 aggregate steer，执行既有隐藏、折叠、展开和分组。
2. 普通用户消息关闭自绘时，调用原生/下游 renderer，保持其结果。
3. 需要自绘的内容先去标记参与布局，最终输出只加一次宿主要求的导航标记，再缓存。

配置贯穿 schema、读取、规范化、序列化、设置面板、示例与双语 README；不能只修改 `isEnabled()`。

### 导航与补丁所有权

- 沿用 Pi 的 OSC 133 规则：可见用户消息有标记；assistant 是否标记跟随宿主，不给含 tool call 的 assistant 自造边界。
- A 必须保持行首；单行输出 A 在前；空/隐藏内容仍为零行。BEL/ST 形式均识别。
- 原生 passthrough 不再加一遍；cache hit 不叠标记；标记不能变成可见文本或影响测宽。
- 清理/重装只恢复本扩展仍拥有的包装；旧 session 不得拆除新包装，不能抹掉另一个用户消息 renderer。

## Contract / Test Impact

以下均测试行为，不用“可变 ToolInfo”假对象替代真实注册。

| 档位 / 场景 | 预期 |
|---|---|
| T1：两层/三层并行 nested | 子调用归正确根；一个顶层计数；无不存在的宿主 |
| T1：部分失败、取消、外层异常 | 可见真实状态；不把脚本成功等同全子调用成功 |
| T1：calls 超限、参数遗漏、旧历史 | 明确不完整；不伪造正文、精确总数或层级 |
| T1：缓存 warm 后重复 render | 重用已布局内容；更新/主题/宽度/展开后正确刷新 |
| T1：所有输出路径超预算 | 都受限且提示省略；无先完整序列化的大对象风险 |
| T1：两布局 × userMessageBox 开关 | 普通消息按偏好显示，steer 行为不变 |
| T1：隐藏/空/单行、cache hit、BEL/ST | 宿主导航边界正确且只标记一次 |
| T2：codemode 未加载/未启用，包含旧 codemode 历史 | 普通调用及历史可读，不自动启用、重执行或要求脚本运行时 |
| T2：真实 1.1 loader + Bash/codemode | schema/grammar、结构化成功和非零退出、context/取消不丢 |
| T1/T2：直接/nested 调用 Bash 未带 displaySummary | 现有 prepareArguments 补位生效，原必填意图契约不被削弱；其他非法参数仍拒绝，底层不接收展示字段 |
| T2：MCP 晚连接、不同加载顺序、旧工具名 | resolver 接管正确，专用 renderer 能委托，无工具重注册副作用 |
| T2：live→结束→reload/tree/compact/HTML | 已记录事实一致；没有的数据明确缺失 |
| T2：真实 fullscreen 导航及 100/300 工具历史 | 上下消息导航恢复；输入性能测量与组件收益分开报告 |

先补测试 `AggregateTerminal.setProgramStatus()`；此前五条诊断是 fixture 契约缺失，不是生产 TUI 已崩溃的证据。

## PR 处置

- **#149**：保留父子归属的产品意图、脚本详情入口和展示 fallback；重做注册接入、投影、预算及真实集成测试。拒绝修改 ToolInfo 副本、强加 codemode schema、无界展开/错误输出和以源码扫描推断执行。通过替代实现后说明采纳范围并关联关闭；不直接合入原 PR。
- **#150**：保留 marker helper、最终输出标记、跟随宿主和 cache-hit 思路；按当前 head 与 W4 联合接线并验证 1.1。作者旧测试记录不代替新验收，不单独发布旧宿主补丁。
- **#148/#151**：按用户行为验收后关闭，不以“关联 PR 已合入”代替。

顺序：renderer/语义拆分 → 缓存/预算 → codemode 投影；用户消息/marker 可分文件并行，但共用一位整合负责人。首次进入实施需补精确行为测试设计，完成后更新现有 aggregate 文档，保留 Goal/AC/关键决策。
