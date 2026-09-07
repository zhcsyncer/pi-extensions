# pi-consult

状态：已落地

待验证方案：[Executor context](./executor-context-proposal.md)；暂不改变上下文构建，积累样本后通过 events 关联 transcript 复评。

## 为什么做

主会话已经是强模型。顾问不是更贵的执行层，而是按需、无工具、无用户输出的第二意见：recommend / confirm / revise / stop。触发不能只靠自觉——卡住（相同调用 / 连续 error）可以观测，方案分叉不能，所以 v0 用 guidelines 的 `why` 承担高后果且证据未决的分叉，用 watchdog 承担卡住；仅仅能列出多个选项不构成触发理由。

不装现成 advisor 包：叙事几乎都是「便宜执行 + 贵顾问」或重编排。要的形状（panel、gate、jsonl）会改到主干，fork 等于重写。

不做自动「收尾复核」。那是改码后的 review，不是执行中的决策顾问。

## 心智模型

```text
主模型 ──consult({why})──► 顾问 streamSimple(tools:[]) ──envelope──► tool result
                ▲
                └── watchdog steer 只催这一次调用，不替主模型执行
```

- 顾问看不到用户，也不回传 thinking。summary 跟随最近一条实质性用户请求的主要语言，JSON keys/verdict 与路径、标识符、命令、引用代码保持原样。summary 可在有助表达时使用 Markdown，不额外禁止标题、表格或代码块；展开态交给 Pi 原生 Markdown 渲染，折叠态仅生成去除展示标记的单行预览。
- `consult` 必须作为当前 assistant step 的唯一工具调用，并等结果后再调其他工具；顾问快照只剥离当前 consult，同时保留用户图片。主模型 on-demand 调用只允许三类：用户明确要求顾问、后果重大的证据未决结构选择、同一方案重复失败到可能要放弃。用户已拍板、可逆 UI/default/calibration、主模型自身评估、工具结果已给出机械下一步时直接回答或执行。顾问是挑战而非权威，证据支持 reject；下一条可见回复必须精确使用 `adopt | changed:`、`adopt | confirmed:` 或 `reject |` 三种 `CONSULT-LOG:` 形式。
- Watchdog 强制 panel[0]；`fanout` 只作用于 on-demand 调用。watchdog 默认阈值为 5；触发后锁保持到 Consult 结束，Consult 自身不参与 watchdog 复评，结束时清空旧 fingerprint，下一次必须重新累计 N 个新事件。`budget.perRun` 默认 3，从一次真实用户输入覆盖到下一次用户输入；旧 `perTurn` 只作解析别名。预算在发出顾问请求前原子占位，并按请求尝试计数（失败或取消也计）。所有实际请求（含空响应重试和 fanout）按标准 Usage 聚合到顶层 toolResult，Pi session 计入 Tools/summaries；raw/events 保留顾问模型、cache 与 cost 供账本使用，但 Consult UI 只显示 input/output/total tokens。
- 未配 panel：从 active tools 卸掉，prompt 零占用。
- `/consult status` 只打开 `ctx.ui.custom()` 临时 dashboard，集中展示 panel、gates、预算和最近五次活动；`q`/Esc 关闭。它不发 notify/custom message，也不向 transcript 写状态文本。
- TUI 跟 tool-display-intent 的 Claude 行：等待期消费流式事件，显示 `connecting → thinking → writing`、节流后的 `~out` 估算和耗时；完成后以精确 usage 替换。收起态和展开态都在每位顾问的一行内显示 `on-demand|watchdog · provider/model:effort · in/out/total · duration`，重试时追加 `retry N`，不显示 cache/cost。正常完成显示 `recommend/confirm/revise/stop/split`，策略拒绝显示 `blocked`，请求错误显示 `failed`，用户取消显示 `cancelled`。完成结果收起为 `status · summary` 并带 Ctrl+O，展开后 why 在标题换行、结果区以 Markdown 展示 summary。只有正常顾问反馈要求 `CONSULT-LOG:`；该行仍是普通 assistant 文本，同时把 adoption 与 reason 派生回贴到对应 Consult 行，并将 changed / confirmed / rejected 效果按 `session + toolCallId` 精确关联到事件。reload 从当前会话分支重建，不额外持久化副本。watchdog 用 `sendUserMessage(..., { deliverAs: "steer" })`，首行 `先 consult 再继续`，有 aggregate 时进同一本 Tools 账本的 `↳`。

## 红线

- 不做 subagent、council/debate、每 turn 后台审、合成模型、CLI backend、自动 done/review gate。
- 失败全部落 tool result，不砸会话。
- jsonl 只记行为字段，不写会话原文。每次工具调用（含 blocked/failed）记录 `session + toolCallId`、outcome、trigger、verdict 与 usage；`adopted` / `adoptionEffect` 靠后续 `CONSULT-LOG:` 自报，可信度有限。consult 与 adoption 各追加一条记录，读取时按联合键精确归并，避免并发重写；仍保留单个 events.jsonl。Advisor 不为自己的触发必要性打分，是否触发合理继续通过 transcript 关联做事后整体评估。
- Consult 不尝试控制 provider 缓存；Pi 的 `cacheRetention` 是 provider capability，当前 Cursor adapter 不转发该选项。
- 配置与日志走仓库统一根：`$PI_CODING_AGENT_DIR/extension-data/pi-consult/`。规格草稿里的 `~/.config/pi-consult/consult.json` 与 `~/.pi/agent/consult/events.jsonl` 不采用，避免和本仓库 extension-data 方案分叉。
