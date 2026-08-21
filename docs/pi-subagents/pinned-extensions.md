# pi-subagents 钉住扩展（pinned extensions）

## 状态

已落地。本文固定问题事实、需求边界与设计决策，避免依赖口头上下文。

## 背景

### 问题事实

pi-meter（`packages/pi-meter`）的实时用量摄入只依赖 `pi.on("message_end")`（`extensions/meter.ts`），该钩子只绑定在"pi-meter 被加载的那个会话"上。它注册的其他钩子（`session_start`、`session_shutdown`、`agent_settled`、`model_select`）同样如此；它不监听任何 `subagents:*` 事件。

pi-subagents 的子代理在同一进程内用独立的 `DefaultResourceLoader` 创建会话（`packages/pi-subagents/src/agent-runner.ts` 的 `runAgent`）。扩展加载由 agent 配置决定：

- `isolated: true` → `extensions` 被强制覆盖为 `false`（`agent-runner.ts`：`const extensions = options.isolated ? false : config.extensions`）；
- `extensions: false` 或未包含 pi-meter 的子集 → loader 以 `noExtensions: true` 或 `extensionsOverride` 过滤，pi-meter 在子会话中不加载。

结果：这些子会话产生的 token 消耗对 pi-meter 的账本、预算告警、footer **实时不可见**。

### 已有的部分补偿及其不足

1. **pi-subagents 父进程聚合**：`runAgent` 订阅子会话 `message_end`，经 `onAssistantUsage` 累加到 `AgentManager` 的 `record.lifetimeUsage`，终态时经 `pi.events.emit("subagents:completed"/"failed", ...)` 广播（`src/runtime-events.ts` 的 `buildAgentEventData`）。但事件载荷只有 `{input, output, total}` 一次性总和：
   - 丢维度：无模型/provider 归属（子代理常跑与父会话不同的模型，而账本按模型聚合）、无 cost、无 cacheRead/cacheWrite 明细、无逐消息时间戳（跨天长任务的用量会全记到结束当天，日/周预算窗口错位）；
   - 只在终态发一次：长时间后台代理运行期间预算/footer 全程盲区，进程崩溃则永久丢失；
   - 无法与回填去重：lump-sum 合成记录没有真实消息时间戳，与 `/usage import` 的逐消息记录（键为 `ts|sid|model`，见 pi-meter `src/ledger/session-parser.ts` 的 `recordKey`/`payloadKey`）不可比对。

   目前该事件只喂 pi-subagents 自身 UI（fleet 列表、完成通知），不入任何账本——现状下不存在重复记账。

2. **事后回填**：子会话默认持久化（`persistSession` 默认 true），`/usage import` 解析会话文件可全保真回填（逐消息、含模型与时间戳）。因此真正的缺口只有两块：**实时性**（预算/footer 的活数据）与 **`persist_session: false` 的会话**。

### 去重闭环（实施后成立的前提）

- 子会话内的 pi-meter 逐消息记账，键为 `ts|sid|model`（真实消息时间戳 + 子会话自己的 session id）；
- 父会话的 pi-meter 只见父会话的 `message_end`，sid 不同，两边天然不相交；
- `/usage import` 对同一子会话文件产出的记录与活捕获记录键完全一致，`diffRecords` 去重后丢弃。

**反需求**：不得给 pi-meter 增加"监听 `subagents:completed` 入账"的逻辑——lump-sum 无法去重，加了才会造成重复记账。pin 机制本身不需要改 pi-meter 任何代码。

## 需求

在 pi-subagents 层面提供一个白名单机制：白名单中的扩展在**所有**子代理会话中始终加载，不受 agent 配置的 `isolated: true`、`extensions: false`、`extensions: [...]` 子集及 `exclude_extensions:` 影响。

适用对象：统计/观测类扩展（当前具体动机是 pi-meter）。

约束：

1. 不得破坏 `isolated` 的对外契约（"子代理看不到任何扩展工具"）；
2. "不可禁用"的授权必须来自用户，不得由扩展作者自声明；
3. 不引入 pi-subagents 与具体统计扩展之间的专有协议。

## 设计

### 核心语义：只保加载，不保工具

把白名单定义为"钉住的观察者"（pinned observers）：

- **有效加载集 = 配置解析结果 ∪ 钉住集**。被钉扩展在所有子会话里加载、handlers 正常绑定（`message_end` 等事件照常送达）；
- **工具集只看配置解析结果**。被钉扩展的工具可见性完全跟随原有 `extensions:`/`ext:`/`isolated` 规则——若某扩展仅因 pin 而加载（配置本身没让它进来），其注册的工具对 LLM 一律不可见、不可调用。

理由：若 pin 连工具一起保，任何被钉扩展都能击穿 `isolated`，"不可禁用"就从统计特性变成后门。pi-meter 不注册任何工具（只注册 `/usage` 命令），该语义对它零损失；但机制必须成立，否则将来钉一个带工具的扩展就破坏了 isolated 契约。

### 决策 1：白名单放 pi-subagents settings，不放扩展自声明

在 `SubagentsSettings`（`src/settings.ts`）新增：

```ts
/**
 * Extension names that load in EVERY subagent session, regardless of the
 * agent's `isolated` / `extensions:` / `exclude_extensions:` configuration.
 * Load-and-observe only: pinning never exposes an extension's tools to the
 * subagent LLM — tool visibility still follows the agent's own config.
 * Intended for user-trusted stats/observer extensions (e.g. pi-meter).
 */
pinnedExtensions?: string[];
```

- 走现成的 global 提供默认、project 覆盖的合并机制（`loadSettings` 的 `{...global, ...project}`；注意是整字段覆盖，project 设了 `[]` 即清空全局 pin，这是刻意语义：项目可显式退出）；
- 名字匹配复用 `extensionCanonicalNames`（`agent-runner.ts`）：大小写不敏感，按目录/文件名与 pi 包短名（`@scope/foo` → `foo`）匹配，`pi-meter` 两种途径都能命中；
- `sanitize` 中校验为字符串数组，去空、lowercase、去重；
- 不采用 package.json 自声明作为主机制："我不可被禁用"这个授权应来自用户（settings 是用户/项目所有），不该由扩展作者给自己发。

### 决策 2：加载路径改动（`agent-runner.ts`）

设 `pinned: Set<string>`（来自 settings，经 canonical 化）。仅当 `pinned` 非空时以下行为变化生效；`pinned` 为空则所有路径与现状完全一致（零回归面）。

现状的三条路径与改动：

| 配置解析结果 | 现状 | pin 非空时 |
| --- | --- | --- |
| `extensions: false` / `isolated`（`noExtensions`） | `noExtensions: true`，loader 完全跳过发现 | 不能走捷径：`noExtensions: false`，正常发现 + `extensionsOverride` 过滤到 pinned-only |
| `extensions: true` 或 `"*"` 且无 exclude（`loadAll`） | 无 override，全量加载 | 不变（pinned 本来就在全量里） |
| 子集 / 带 exclude（现有 override） | keep = `loadAll \|\| keepNames` 减 `excludeNames` | keep 条件并上 `pinned`，且 pinned 命中时跳过 exclude 判断（pin 赢） |

副作用与接受理由：isolated 子代理会多付一次扩展发现与 factory 执行的成本，仅在用户显式配置了 pin 时发生；这正是用户要的语义（"统计扩展始终在场"），可接受。

### 决策 3：工具遮蔽（`installExtensionToolScope`）

改走 override 后原 `noExtensions` 分支失效，会落入 excludeTools + `installExtensionToolScope` 分支。由于扩展工具可能晚注册（pi-mcp 在 `session_start`、context-mode 在 `before_agent_start` 才 `registerTool`），静态排除不可行，需动态遮蔽：

- 计算 `pinnedOnly: Set<string>` = 仅因 pin 而加载的扩展 canonical 名集合（即：不在配置解析的 keep 集合里、也不属于 `loadAll` 语义覆盖的扩展）；
- `installExtensionToolScope` 的 ctx 增加 `pinnedOnly`，`inScope()` 遍历 `loader.getExtensions()` 时，凡 canonical 名命中 `pinnedOnly` 的扩展，其全部工具无条件跳过；
- 该遮蔽同时作用于两个执行点（`turn_end` 的主动收窄 + `beforeToolCall` 的调用时拦截），与现有机制同构。

`isolated` + pin 的组合走的正是"pinned-only 加载 + 全部工具遮蔽"，等价于"isolated 但多了旁观者"，isolated 的工具面契约保持不变。

`pinnedOnly` 的判定是「没有 pin 时配置会不会加载它」：`extensions: true` + `exclude_extensions:` 点名被钉扩展时，配置本身不会加载，因此仍算 pinned-only，工具被遮蔽。这与「exclude 仅对工具面生效」的告警一致。

### 决策 4：冲突与告警降噪

- agent 的 `exclude_extensions:` 显式点名了被钉扩展：加载仍保留（pin 赢），发一次 warning（复用现有 `onToolActivity` 的 `extension-error:` 通道，措辞说明"该扩展被 settings 钉住，exclude 仅对工具面生效"）；
- 全局 pin 的名字在当前项目未发现（未安装）：**静默跳过**。全局钉 pi-meter 但某项目没装它是常态，不该刷警告。这与现有 `exclude_extensions` 的 typo 警告策略刻意不同；
- pin 与 `extensions: [...]` 同名重复：无冲突，自然合并，不告警。

### 边界声明（须写入 README）

**pin 不是沙箱**。被钉扩展的 handlers 照常运行——理论上 `before_agent_start` 之类的钩子仍能影响子会话。机制定位是"用户信任的统计/观测类扩展"，这正是白名单必须由用户在 settings 里授权、而非扩展自声明的原因。文档应明确：只钉你信任的、行为为纯观察的扩展。

## 已评估并否决的替代方案

1. **加强事件转发**：让 pi-subagents 逐消息转发 `{sid, model, usage, timestamp}` 供父会话的 pi-meter 记账。可补齐保真度与实时性，但属于 pi-subagents 与每个统计扩展间的专有协议，只覆盖"用量"一种观察需求（无法推广到"审计子代理每次工具调用"等），且要求父会话必须加载 pi-meter。违反约束 3。
2. **什么都不做**：依赖 `/usage import` 事后对账。账本完整性基本成立，但放弃实时预算对子代理的覆盖，且 `persist_session: false` 的会话永久丢失。
3. **package.json 自声明 pin**：违反约束 2（授权来源错误），否决作为主机制；将来若有需要，可作为"扩展建议、用户确认"的辅助发现渠道，不在本设计范围内。
