# @zhcsyncer/pi-subagents

[English](./README.md)

[`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) 的维护向 fork（基线 `v0.14.3` / `@tintinweb/pi-subagents@0.14.3`）。

本包可单独发布，也会嵌入聚合包 `@zhcsyncer/pi-extensions`。

**完整上游说明**（功能、Agent 工具、调度、设置）：[`UPSTREAM_README.md`](./UPSTREAM_README.md)  
**版本钉扎与许可证**：[`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md) · [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE)

---

## 与上游的差异（先看这里）

本 fork 保留上游日常 **Agent 运行时行为**，但会改变“手动启动的后台任务”如何投递完成结果，避免当前任务所需结果被主 agent 的长工具循环饿死。其余改动主要优化 TUI 中的进展与 tool 结果呈现；此外提供一条显式启用的进程内 spawn 契约，供编排型扩展调用。这里还选择性移植了上游 0.17 的 session 默认持久化与 `isolation: "off"`，但本 fork 的 worktree 默认**关闭**。

| 区域 | 上游 `@tintinweb/pi-subagents` | 本 fork `@zhcsyncer/pi-subagents` |
| --- | --- | --- |
| **对话 overlay**（FleetView / 列表 → Enter） | 全文 dump：user / assistant / toolResult 墙（tool 体约 500 字截断仍很大） | **方案 A 摘要视图**：**Prompt** → **Usage** → **Steps**（一行一步）→ **Result**；tool 体默认折叠 |
| 运行状态 / 指标 | 空闲进度 fallback 为 `thinking…`；长任务一直显示大秒数；紧凑 token 与 context 容易被看成同一指标 | 语义诚实的 `working…` fallback，并仅延迟展示稳定的粗粒度阶段；分钟/小时友好时长且只高亮时长片段；紧凑 **lifetime** 总量与 **current context** 明确分开，overlay 提供完整 usage breakdown |
| Overlay 步骤详情 | 无（全摊开） | **`o`** 展开/折叠 tool 参数与结果 |
| Overlay 在 agent **error / aborted / stopped / steered** | 仍以消息流为主 | **Result 优先 `record.error`**；`steered` 标明 turn-limit；头部图标对齐 chrome；终态收敛悬空 running step |
| Overlay **bashExecution** | 命令 + 输出 dump | 一步一行；**`exitCode` / `cancelled`** → `✗`（不会误标 ✓） |
| **主 transcript** `Agent` / `get_subagent_result` / `steer_subagent` | `Agent` 有 Claude Code 样式；**`get_subagent_result` 无自定义 `renderResult`** → 整段 dump | 三者统一 **Claude Code chrome**；queued 真话；**Ctrl+O** 展开 Markdown，默认不 dump |
| Tool **model / effort** | 与父模型相同时常不显示；thinking 只在 tags | **结果 stats** 始终含有效模型（继承则 `haiku (inherit)`）与 `effort:`；resume 用存储的 invocation |
| 校验失败 / 找不到 agent 等 | 纯文本 result（折叠改造后易误读成成功） | `error` details + `tool_result`→`isError`（错误外壳）；undetailed 成功路径不启发式染红 |
| 后台完成投递 | 手动 Agent-tool、schedule 与 RPC 都使用 `followUp`；主 agent 长工具循环可能饿死当前任务结果 | 手动 Agent-tool 后台完成使用 `steer`；schedule / RPC 等脱离当前推理链的任务保留 `followUp`；继续使用 `triggerTurn: true` |
| 子 agent Pi session | 钉扎的 0.14.3 基线默认内存运行，只有 `persist_session: true` 才落盘 | 普通子 agent 默认持久化，记录父 session，在 `/resume` 中挂到父会话下，并可从 `/agents` 的结束历史打开；`persist_session: false` 或 `rememberAgents: false` 可恢复内存运行 |
| Worktree 隔离 | 上游 0.17 增加 `"off"` / `"worktree"` 与默认开启的仓库开关 | 同样使用 `"off"` / `"worktree"`（`off` 在前），但 `worktreeIsolation` 默认 **false**；关闭时 schema 与说明都消失，tool/frontmatter/schedule/RPC 的 worktree 请求全部降级到真实 checkout |
| 编排合同 | foreground / background 的工作所有权容易混淆 | 后续步骤依赖结果时必须 foreground；background 只用于真正互不重叠的工作；主 agent 负责综合和定向验证，但不得重复已委派的证据收集 |
| 跨扩展编排 | named-agent spawn RPC | protocol v3 增加可选 inline 角色、调用方收口、route 关联、实际 route 元数据与并发上限查询 |
| 发包 | 独立 npm 包 | 独立包 `@zhcsyncer/pi-subagents`，**并**嵌入/注册进根包 `@zhcsyncer/pi-extensions` |

### 未改动的部分

- 工具名：`Agent`、`get_subagent_result`、`steer_subagent`；除条件化 `isolation` enum 以外的参数
- 完成通知继续使用 `triggerTurn: true`；schedule / RPC 等 detached 任务仍使用 `followUp`
- FleetView 导航、Enter steer、`x` `x` stop、Esc/q 关闭
- 自定义 agent、调度与现有 Settings 菜单结构
- 不传 protocol-v3 新字段时，原有跨扩展 spawn 行为不变

日常 Agent 行为细节仍以上游文档为准：[`UPSTREAM_README.md`](./UPSTREAM_README.md)。

### 跨扩展 spawn protocol v3

这里的“RPC”只是 Pi 扩展之间通过 `pi.events` 做的进程内调用，不是网络服务。现有 `subagents:rpc:spawn` request 新增三个可选字段：

- `inlineAgentConfig`：直接使用调用方给出的角色 prompt/tools，不查找 named agent，也不 fallback；
- `completionOwner: "caller"`：保留 queue、stop、FleetView、lifecycle event 与 history，但不向主会话发送单 agent 完成通知；
- `correlationId`：在 started/terminal event 中原样带回编排方的 route key；
- `graceTurns`：可选，软上限 steer 之后的收尾轮数；省略时仍用全局默认 5 轮。

调用方收口要求 `isBackground: true` 且 `correlationId` 非空。`subagents:rpc:ping` 返回 protocol version `3` 和 `maxConcurrent`；关联后的 terminal event 会给出请求与实际生效的 model/thinking。不传任何新字段时，仍走原来的 named-agent 与完成通知路径。

### Foreground / background 合同

如果 subagent 结果是主 agent 下一次 read、edit 或 decision 的前置条件，应使用 foreground。只有主 agent 确实有互不重叠的并行工作时才使用 background。后台完成会自动投递；等待期间不要轮询、sleep，也不要重复 subagent 已承担的 grep / find / read 证据收集。

主 agent 仍负责综合、决策、面向用户的报告与最终验证。报告到达后，只对高风险结论做定向抽查，不要重跑整轮调查。`steer` 完成通知能在主 agent 下一次模型调用前进入上下文，但无法撤回同一 assistant turn 已发出的 sibling tools。

投递策略在 spawn 时固定：

- 手动 Agent-tool background（包括 frontmatter 最终解析为 `run_in_background: true` 的自定义 agent）：`steer`
- schedule 与跨扩展 RPC：`followUp`
- foreground：结果 inline 返回，不发送后台完成 nudge

需要复用同一执行语义、但不希望激活完整扩展的依赖包，可以导入 `@zhcsyncer/pi-subagents/runtime`。只导入该子路径不会注册 Agent 工具、命令、调度、widget 或 FleetView；构造和释放由调用方负责。

### Session 持久化与仓库 worktree

子 agent 现在默认使用 `SessionManager.create`。child header 会把当前主 session 文件记为 `parentSession`，所以普通同目录运行会在 Pi 的 `/resume` 中挂到发起它的父会话下，也能在那里打开完整对话。`/agents` 还会按名称和状态显示 **Finished agents in this session**：live record 仍用现有摘要 ConversationViewer；record 被回收后，同一个只读 overlay 会改为打开磁盘 session 文件。

若某个 agent 需要临时运行，在 agent 文件中设 `persist_session: false`；若项目整体要恢复默认内存行为，在 `/agents → Settings` 或项目配置中设 `rememberAgents: false`。显式 `persist_session: true` 仍可反向覆盖该设置。

Worktree 创建现在是仓库能力开关，本 fork 默认**关闭**。`worktreeIsolation: false` 时，Agent 工具既没有 `isolation` 参数，也不会保留 worktree 说明；来自 agent 文件、scheduler 或跨扩展 RPC 的 `worktree` 请求会直接在真实 checkout 运行。通过 `/agents → Settings` 开启 **Worktree isolation** 后，下一次 Pi session 会重新暴露 `isolation: "off" | "worktree"`（`off` 在前）。开关开启后若 worktree 实际创建失败，仍会抛错，绝不静默 fallback。

---

## 安装

单独安装：

```bash
pi install npm:@zhcsyncer/pi-subagents
```

或通过根 bundle（注册同一扩展）：

```bash
pi install npm:@zhcsyncer/pi-extensions
```

若 `~/.pi/agent/settings.json` 已加载 `@tintinweb/pi-subagents`，请先去掉该条目——两边都会注册 `Agent` / FleetView，不能并存。

## 本地试用（本 monorepo）

```bash
# monorepo 根目录
pnpm install
pi --no-extensions -e ./packages/pi-subagents
# 或加载整个根 bundle：
pi -e .
```

### 对话 overlay（方案 A）

FleetView / agent 列表选中子 agent 后回车：

1. **Header** — 名称 / 状态 / 高亮时长 / tools / 紧凑 **lifetime** tokens 与 **current ctx** 百分比
2. **Prompt** — 第一条有意义的 user（派发）消息
3. **Usage** — lifetime `input` / `output` / `cache read` / `cache write`、可用时的 cost，以及单独列出的当前 context
4. **Steps** — 每个 tool 一行摘要；结果默认折叠
5. **Result** — 最终 assistant 文本、`working…` fallback，或终态 **error**

| 键 | 行为 |
| --- | --- |
| `Esc` / `q` | 关闭 |
| `↑↓` / PgUp/PgDn | 滚动 |
| `Enter` | Steer（运行中） |
| `x` `x` | 二次确认停止 |
| `o` | 展开/折叠步骤详情（**本 fork**） |

### 主会话 tool TUI — Claude Code chrome

主会话 transcript 使用 Claude Code Task chrome（`renderShell: "self"`，无背景盒）：

```text
● Explore(Find auth files)  haiku · bg
  ⎿  ⠹ exploring… · ↻3 · 3 tool uses · haiku
  ⎿  Done · ↻8 · 5 tool uses · lifetime 33.8k token · 10 min 13s · haiku
```

| 状态 | 呈现 |
| --- | --- |
| **调用行** | `● Type(description)`（仅当 args 显式带 model/thinking/bg 时附加 dim 芯片） |
| **运行中** | `⎿` spinner + 稳定的粗粒度阶段（`exploring…`、`editing…`、`running commands…` 或 `delegating…`）；否则显示 `working…` |
| **完成** | `⎿ Done` · turns · tool uses · lifetime tokens · 时长 · 有效 model（Wrapped up / Stopped / Error 变体） |
| **展开**（`Ctrl+O`） | 结果 clerk + effort/隔离/cost/transcript/worktree clerk + **Markdown** 正文 |

`effort` 对应 `thinking`。有效 **model**（含继承）留在折叠 clerk。spawn 配置（`effort`、`isolated`、`worktree`、`twin`）和次要信号（`cost`、低 context %、transcript 路径）放到展开态，避免折叠行堆叠。context ≥70% 与 compaction 次数仍留在折叠 clerk。

紧凑运行界面不会流式展示文件路径、命令或 assistant 正文。快速步骤与未知工作保持 `working…`；已知粗粒度阶段持续约 0.8 秒后才出现，并至少保持 1.5 秒以避免闪烁。逐 tool 的精确步骤仍可在 conversation overlay 中查看。

紧凑 **lifetime** token 数刻意保留原有的 `input + output + cache write` 语义；`cache read` 会被保留并显示在 Usage breakdown 中，但不会悄悄加回这个总量（见[上游 issue #38](https://github.com/tintinweb/pi-subagents/issues/38)）。**Current ctx** 表示当前 context window 的占用率，不是 lifetime 总量的百分比。时长不足一分钟时仍显示秒数，之后切换为 `10 min 13s`、`1 hr 2 min 3s` 等易读的分钟/小时格式。

## 配置存储

运行设置现已使用 extension-data 布局：

- 全局默认值：`$PI_CODING_AGENT_DIR/extension-data/pi-subagents/config.json`
- 项目覆盖：`<cwd>/<CONFIG_DIR_NAME>/extension-data/pi-subagents/config.json`（通常是 `<cwd>/.pi/extension-data/pi-subagents/config.json`）

项目字段覆盖全局字段。`/agents` → Settings 仍只写项目文件；全局文件继续手工编辑。可选的自定义 Agent 工具描述使用对应全局或项目 `config.json` 同目录下的 `agent-tool-description.md`，项目内容优先。Worktree 说明应使用 `{{isolationGuideline}}`，不要硬编码；这样仓库禁用该能力时，说明会与 schema 一起消失。相关默认值为 `rememberAgents: true` 与 `worktreeIsolation: false`；worktree schema/说明变更在下一次 Pi session 生效，而运行时降级会立即生效。

原全局/项目 `subagents.json` 与 `agent-tool-description.md` 只作为一次性迁移输入。迁移通过同目录原子 rename 写入，并在删除旧文件前进行语义复读。canonical 文件始终优先；格式损坏、不可读或冲突的旧文件会保留，并只给出一次去重 warning。

本次迁移只覆盖 pi-subagents 自身的运行设置和工具描述 override。自定义 agent、Pi/native skills 与 `settings.json`、memory、schedule、session 持久化、worktree 和 `.output` transcript 均保留原有 resource 或 runtime 位置。Provider credential 仍保存在 Pi 的 `auth.json`。

---

## 脚本

```bash
pnpm --filter @zhcsyncer/pi-subagents check
pnpm --filter @zhcsyncer/pi-subagents test
pnpm --filter @zhcsyncer/pi-subagents typecheck
```

## License

MIT — [LICENSE](./LICENSE) 与上游 [UPSTREAM_LICENSE](./UPSTREAM_LICENSE)。
