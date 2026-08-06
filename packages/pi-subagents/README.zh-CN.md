# @zhcsyncer/pi-subagents

[`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) 的维护向 fork（基线 `v0.14.3` / `@tintinweb/pi-subagents@0.14.3`）。

> English: [README.md](./README.md)

**完整上游说明**（功能、Agent 工具、调度、设置）：[`UPSTREAM_README.md`](./UPSTREAM_README.md)  
**版本钉扎与许可证**：[`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md) · [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE)

---

## 与上游的差异（先看这里）

本 fork **保留上游运行时行为**（spawn / steer / resume、FleetView 接线、完成通知、调度等）。改动几乎都在 **TUI 如何呈现进展与 tool 结果**，避免大段 dump 淹没主会话。

| 区域 | 上游 `@tintinweb/pi-subagents` | 本 fork `@zhcsyncer/pi-subagents` |
| --- | --- | --- |
| **对话 overlay**（FleetView / 列表 → Enter） | 全文 dump：user / assistant / toolResult 墙（tool 体约 500 字截断仍很大） | **方案 A 摘要视图**：**Prompt** → **Steps**（一行一步）→ **Result**；tool 体默认折叠 |
| Overlay 步骤详情 | 无（全摊开） | **`o`** 展开/折叠 tool 参数与结果 |
| Overlay 在 agent **error / aborted / stopped** | 仍以消息流为主 | **Result 优先 `record.error`**（或 stopped/aborted 文案）；中途 assistant 碎语降为 dim 附注 |
| Overlay **bashExecution** | 命令 + 输出 dump | 一步一行；**`exitCode` / `cancelled`** → `✗`（不会误标 ✓） |
| **主 transcript** `Agent` / `get_subagent_result` / `steer_subagent` | `Agent` 有紧凑行；**`get_subagent_result` 无自定义 `renderResult`** → Pi 整段 dump 且无法靠 expand 收起 | 统一可折叠渲染：默认 **一行预览**；**Ctrl+O** 展开为状态头 + **Markdown** 正文 |
| Tool 节点 **model / effort** | 与父模型相同时常不显示 model；thinking 仅偶尔进 tags | 调用行与结果行始终显示 **有效模型**（继承则 `haiku (inherit)`）与 **`effort:`**（来自 `thinking`） |
| 校验失败 / 找不到 agent 等 | 纯文本 result（折叠改造后易误读成成功） | 带 `error` details（或 undetailed 回退 **永不**画绿 ✓） |
| 发包 | 独立 npm 包 | 工作区包 `@zhcsyncer/pi-subagents`，版本 **`0.0.0`** 直至 Changesets 切首版；**尚未**挂进根包 `@zhcsyncer/pi-extensions` bundle — 用下面的 `-e` 试用 |

### 未改动的部分

- 工具名与契约：`Agent`、`get_subagent_result`、`steer_subagent`
- 后台完成 **followUp** 通知（`triggerTurn`）
- FleetView 导航、Enter steer、`x` `x` stop、Esc/q 关闭
- 自定义 agent、worktree、调度、设置菜单、RPC

行为细节仍以上游文档为准：[`UPSTREAM_README.md`](./UPSTREAM_README.md)。

---

## 本地试用（本 monorepo）

**不要**为了试用去改全局 `~/.pi/agent/settings.json`（是否永久替换上游留给人工决定）。

```bash
# monorepo 根目录
pnpm install
pi -e ./packages/pi-subagents/src/index.ts
```

若 settings 已加载另一份 `pi-subagents`，试用会话请先临时去掉该条目，避免双注册。

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

### 主会话 tool TUI

| 状态 | 呈现 |
| --- | --- |
| **调用行** | `▸ Explore  desc  haiku · effort: high · bg`（调用时未指定模型则 `model: inherit`） |
| **折叠** | 状态/统计（model、effort、tools、tokens…）+ 一行预览 |
| **展开**（`Ctrl+O`） | 状态头 + **Markdown** 正文 |

`effort` 是展示名，对应工具/frontmatter 的 `thinking` 字段。

---

## 脚本

```bash
pnpm --filter @zhcsyncer/pi-subagents check
pnpm --filter @zhcsyncer/pi-subagents test
pnpm --filter @zhcsyncer/pi-subagents typecheck
```

## License

MIT — [LICENSE](./LICENSE) 与上游 [UPSTREAM_LICENSE](./UPSTREAM_LICENSE)。
