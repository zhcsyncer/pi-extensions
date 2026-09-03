# pi-consult

状态：已落地

## 为什么做

主会话已经是强模型。顾问不是更贵的执行层，而是按需、无工具、无用户输出的第二意见：plan / correction / stop。触发不能只靠自觉——卡住（相同调用 / 连续 error）可以观测，方案分叉不能，所以 v0 用 guidelines 的 `why` 承担分叉，用 loop gate 承担卡住。

不装现成 advisor 包：叙事几乎都是「便宜执行 + 贵顾问」或重编排。要的形状（panel、gate、jsonl）会改到主干，fork 等于重写。

不做自动「收尾复核」。那是改码后的 review，不是执行中的决策顾问。

## 心智模型

```text
主模型 ──consult({why})──► 顾问 completeSimple(tools:[]) ──envelope──► tool result
                ▲
                └── loop steer 只催这一次调用，不替主模型执行
```

- 顾问看不到用户，也不回传 thinking。
- `consult` 必须作为当前 assistant step 的唯一工具调用，并等结果后再调其他工具；顾问快照只剥离当前 consult，同时保留用户图片。
- 自动 gate 强制 panel[0]；`fanout` 只作用于显式 pull。`budget.perRun` 默认 3，从一次真实用户输入覆盖到下一次用户输入；旧 `perTurn` 只作解析别名。预算在发出顾问请求前原子占位，并按请求尝试计数（失败或取消也计）。所有实际请求（含空响应重试和 fanout）按标准 Usage 聚合到顶层 toolResult，Pi session 计入 Tools/summaries；raw/events 保留顾问模型与 cache 拆分，`/consult status` 显示命中率。
- 未配 panel：从 active tools 卸掉，prompt 零占用。
- `/consult status` 只打开 `ctx.ui.custom()` 临时 dashboard，集中展示 panel、gates、预算和最近五次活动；`q`/Esc 关闭。它不发 notify/custom message，也不向 transcript 写状态文本。
- TUI 跟 tool-display-intent 的 Claude 行：等待期 `consulting model · effort  12s`；正常完成显示 `plan/correction/stop/split`，策略拒绝显示 `blocked`，请求错误显示 `failed`，用户取消显示 `cancelled`。完成结果收起为 `status · summary` 并带 Ctrl+O，展开后 why 在标题换行、结果区是状态 + summary 全文 + 模型。只有正常顾问反馈要求 `CONSULT-LOG:`；该行仍是普通 assistant 文本，同时把 `adopt/reject · reason` 派生回贴到对应 Consult 行。reload 从当前会话分支重建，不额外持久化副本。loop 用 `sendUserMessage(..., { deliverAs: "steer" })`，首行 `先 consult 再继续`，有 aggregate 时进同一本 Tools 账本的 `↳`。

## 红线

- 不做 subagent、council/debate、每 turn 后台审、合成模型、CLI backend、自动 done/review gate。
- 失败全部落 tool result，不砸会话。
- jsonl 只记行为字段，不写会话原文。`adopted` 靠后续 `CONSULT-LOG:` 自报，可信度有限。consult 与 adoption 各追加一条记录，读取时按 session 归并，避免并发重写；仍保留单个 events.jsonl。
- 配置与日志走仓库统一根：`$PI_CODING_AGENT_DIR/extension-data/pi-consult/`。规格草稿里的 `~/.config/pi-consult/consult.json` 与 `~/.pi/agent/consult/events.jsonl` 不采用，避免和本仓库 extension-data 方案分叉。
