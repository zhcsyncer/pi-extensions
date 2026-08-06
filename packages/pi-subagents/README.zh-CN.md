# @zhcsyncer/pi-subagents

[`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) 的维护向 fork。ConversationViewer 默认改为 **步骤摘要视图**：派发 prompt、一行一步的 tool 摘要、最终结果，而不再默认倾倒大段 toolResult 原文。

完整上游说明见 [`UPSTREAM_README.md`](./UPSTREAM_README.md)；版本钉扎与本地差异见 [`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md)。

> English: [README.md](./README.md)

## 本地试用（本 monorepo）

**不要**为了试用去改全局 `~/.pi/agent/settings.json`（留给人工决定是否替换 `@tintinweb/pi-subagents`）。在本 worktree 里：

```bash
# monorepo 根目录
pnpm install
pi -e ./packages/pi-subagents/src/index.ts
```

若 settings 里已经加载了另一份 `pi-subagents`，试用会话请先临时去掉该条目，避免双注册。

### 对话 overlay（方案 A）

FleetView / agent 列表选中子 agent 后回车：

1. **Header** — 名称 / 状态 / 时长 / tools / tokens（保留）
2. **Prompt** — 第一条有意义的 user（派发）消息
3. **Steps** — 每个 tool 调用一行摘要；toolResult 默认折叠
4. **Result** — 最后一条非空 assistant 文本；仍在跑则 `(running…)`

快捷键：

| 键 | 行为 |
| --- | --- |
| `Esc` / `q` | 关闭 |
| `↑↓` / PgUp/PgDn | 滚动 |
| `Enter` | Steer（运行中） |
| `x` `x` | 二次确认停止 |
| `o` | 展开/折叠 tool 参数与结果（**本 fork**） |

## 脚本

```bash
pnpm --filter @zhcsyncer/pi-subagents check
pnpm --filter @zhcsyncer/pi-subagents test
pnpm --filter @zhcsyncer/pi-subagents typecheck
```

## License

MIT — 见 [LICENSE](./LICENSE) 与上游 [UPSTREAM_LICENSE](./UPSTREAM_LICENSE)。
