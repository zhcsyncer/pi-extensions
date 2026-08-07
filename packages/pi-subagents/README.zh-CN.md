# @zhcsyncer/pi-subagents

[English](./README.md)

[`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) 的维护向 fork（基线 `v0.14.3` / `@tintinweb/pi-subagents@0.14.3`）。

本包可单独发布，也会嵌入聚合包 `@zhcsyncer/pi-extensions`。

**完整上游说明**（功能、Agent 工具、调度、设置）：[`UPSTREAM_README.md`](./UPSTREAM_README.md)  
**版本钉扎与许可证**：[`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md) · [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE)

---

## 与上游的差异（先看这里）

本 fork **保留上游运行时行为**（spawn / steer / resume、FleetView 接线、完成通知、调度等）。改动几乎都在 **TUI 如何呈现进展与 tool 结果**，避免大段 dump 淹没主会话。

| 区域 | 上游 `@tintinweb/pi-subagents` | 本 fork `@zhcsyncer/pi-subagents` |
| --- | --- | --- |
| **对话 overlay**（FleetView / 列表 → Enter） | 全文 dump：user / assistant / toolResult 墙（tool 体约 500 字截断仍很大） | **方案 A 摘要视图**：**Prompt** → **Steps**（一行一步）→ **Result**；tool 体默认折叠 |
| Overlay 步骤详情 | 无（全摊开） | **`o`** 展开/折叠 tool 参数与结果 |
| Overlay 在 agent **error / aborted / stopped / steered** | 仍以消息流为主 | **Result 优先 `record.error`**；`steered` 标明 turn-limit；头部图标对齐 chrome；终态收敛悬空 running step |
| Overlay **bashExecution** | 命令 + 输出 dump | 一步一行；**`exitCode` / `cancelled`** → `✗`（不会误标 ✓） |
| **主 transcript** `Agent` / `get_subagent_result` / `steer_subagent` | `Agent` 有 Claude Code 样式；**`get_subagent_result` 无自定义 `renderResult`** → 整段 dump | 三者统一 **Claude Code chrome**；queued 真话；**Ctrl+O** 展开 Markdown，默认不 dump |
| Tool **model / effort** | 与父模型相同时常不显示；thinking 只在 tags | **结果 stats** 始终含有效模型（继承则 `haiku (inherit)`）与 `effort:`；resume 用存储的 invocation |
| 校验失败 / 找不到 agent 等 | 纯文本 result（折叠改造后易误读成成功） | `error` details + `tool_result`→`isError`（错误外壳）；undetailed 成功路径不启发式染红 |
| 发包 | 独立 npm 包 | 独立包 `@zhcsyncer/pi-subagents`，**并**嵌入/注册进根包 `@zhcsyncer/pi-extensions` |

### 未改动的部分

- 工具名与契约：`Agent`、`get_subagent_result`、`steer_subagent`
- 后台完成 **followUp** 通知（`triggerTurn`）
- FleetView 导航、Enter steer、`x` `x` stop、Esc/q 关闭
- 自定义 agent、worktree、调度、设置菜单、RPC

行为细节仍以上游文档为准：[`UPSTREAM_README.md`](./UPSTREAM_README.md)。

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

1. **Header** — 名称 / 状态 / 时长 / tools / tokens（上游）
2. **Prompt** — 第一条有意义的 user（派发）消息
3. **Steps** — 每个 tool 一行摘要；结果默认折叠
4. **Result** — 最终 assistant 文本、运行中指示，或终态 **error**

| 键 | 行为 |
| --- | --- |
| `Esc` / `q` | 关闭 |
| `↑↓` / PgUp/PgDn | 滚动 |
| `Enter` | Steer（运行中） |
| `x` `x` | 二次确认停止 |
| `o` | 展开/折叠步骤详情（**本 fork**） |

### 主会话 tool TUI — Claude Code chrome

对齐上游文档中的呈现（见 [UPSTREAM_README](./UPSTREAM_README.md)）：

```text
▸ Explore  Find auth files
⠹ haiku · effort: high · ↻3 · 3 tool uses · 12.4k token
  ⎿  searching…
✓ haiku · effort: high · ↻8 · 5 tool uses · 33.8k token · 12.3s
  ⎿  Done
```

| 状态 | 呈现 |
| --- | --- |
| **调用行** | `▸ Type  description`（仅当 args 显式带 model/thinking/bg 时附加 dim 芯片） |
| **运行中** | `⠹` + stats / `⎿` activity |
| **完成** | `✓` + stats · duration / `⎿ Done`（或 Wrapped up / Stopped / Error） |
| **展开**（`Ctrl+O`） | 同上 chrome + **Markdown** 正文 |

`effort` 对应 `thinking`。有效 **model**（含继承）在**结果** stats 中展示。

## 配置存储

运行设置现已使用 extension-data 布局：

- 全局默认值：`$PI_CODING_AGENT_DIR/extension-data/pi-subagents/config.json`
- 项目覆盖：`<cwd>/<CONFIG_DIR_NAME>/extension-data/pi-subagents/config.json`（通常是 `<cwd>/.pi/extension-data/pi-subagents/config.json`）

项目字段覆盖全局字段。`/agents` → Settings 仍只写项目文件；全局文件继续手工编辑。可选的自定义 Agent 工具描述使用对应全局或项目 `config.json` 同目录下的 `agent-tool-description.md`，项目内容优先。

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
