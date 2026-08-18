# aggregate：steer 留在同一轮

稳定决策。实现后只把 Why / 分组边界 / 展示契约留在 [`aggregate-layout.md`](./aggregate-layout.md)；本文件是本轮执行规格。

## Goal

一次用户请求被中途改口时，画面仍是**同一本 Tools 账本**。steer 是过程里的转向，不是新任务。

不把多次 steer 拼进第一条 user 正文：那会抹掉改口时间点，也和 `/tree` 的每条 user 节点对不上。

## 已拍板

1. **同一轮**：steer 不断 group。follow-up 与闲时新提问仍新开一轮。
2. **留在工具流中间**：展开后 `↳` 插在它发生的那一截，不挪到第一条 user 下面。
3. **进行中钉顶**：收起且未 settle 时，steer 首行按时间顺序钉在 Tools 头下，再下面才是旁白和当前活动。
4. **结束后留一行**：settle 后不再钉各条首行，标题下留一行 `↳ N steers`。标题括号里不再重复计数。
5. **中间那条原生 `▎` user 框必须藏掉**（收起时零高）。否则和钉顶重复，看起来像又开了一个任务。
6. **不改 session**：不改写 user/assistant/tool 正文，不给消息加持久化 `steering` 字段。

## 用户能看到的行为

进行中：

```text
▎ 原始任务

◐ Tools (31 calls · 5 turns) · read ×18 · edit ×9
  ↳ 先确定方案
  ↳ 不要改 grok，用 xai
  › 正在按新约束改 README
  ◐ Edit(README.md)
```

结束后：

```text
✓ Tools (31 calls · 5 turns) · read ×18 · edit ×9
  ↳ 2 steers
  took 2m14s · tok ↑62k ↓8.4k R120k W4.1k · at 14:32:14
```

`Ctrl+O` 展开：

```text
✓ Tools (31 calls · 5 turns) · read ×18 · edit ×9
  ↳ 2 steers
  took 2m14s · …
  │ › 先读 README
  │ ✓ Read(README.md)
  │
  │ ↳ 先确定方案
  │
  │ › 按新约束改
  │ ✓ Edit(README.md)
  │
  │ ↳ 不要改 grok，用 xai
  │
  └ ◐ Bash(pnpm test)
```

符号分开：原任务 `▎`，steer 用 accent 的 `↳`（展开时整条首行高亮），旁白继续 `›`。计数只出现在标题下那一行，不当错误。1 条写 `steer`，多条写 `steers`。展开后 `↳` 上下各空一行且空行带 `│`；Pi 插在 user 前的无边空白会被收掉，避免边线断开。

钉住只取每条 steer 的**首行**（截到行宽），条数按时间全留，不做 `+N`。展开后才显示完整正文（过长按现有旁白/user 截断习惯，不要倾倒整段粘贴日志到无限高）。

## 如何认出 steer

落盘 user 消息没有 `steering` 字段，只有 `role / content / timestamp`。靠过程位置：

| 情况 | 判定 |
|---|---|
| 本 group 未 settle，且上一条可见消息是 `toolUse` / `toolResult` 之后的 user | **steer**，并入当前 group |
| 连续多条这样的 user（`steeringMode=all` 一次倒空） | 都是 steer，同一 group |
| live：`input.streamingBehavior === "steer"`，或 agent 仍在跑、下一条 user 满足上一行 | 同上 |
| 上一条已是终态 assistant（无未完成 tool 批次），再来的 user | **新一轮**（follow-up 或闲时提问） |
| custom message（`sendMessage` / 子 agent 完成通知） | 不是 user，不断 group，也不当 steer 钉顶 |

不要在 steer 到达时把上一批 running 工具标成 failed。真实 steer 是等当前 tool 批次跑完再插入的。

reload / tree / compaction 用同一条位置规则从当前 branch 重建。接受：第一句 assistant 还没调用工具就改口时，reload 可能仍会拆开——宁可拆开，也不要把闲时新提问并进旧账。

## 非目标

- 不把 steer 文本写进上一条 user message。
- 不给 session 加持久化标记。
- 不改 tool 执行、call/result、模型上下文。
- 不把 follow-up 当成 steer。
- 不推断“分析中 / 实现中”。

## 验收

1. 工具批次之后插入 1 条或多条 steer：仍是一本 Tools，call/turn 累计，不新开第二本。
2. 进行中账本头下按时间钉住各条 steer **首行**，再下面是 `›` 旁白和当前活动。
3. settle 后各条首行撤掉，标题下留一行 `↳ N steers`，标题括号里不再重复计数；耗时从原请求开始算到本轮结束。
4. 收起时中间不再出现第二条 `▎` user 框。
5. `Ctrl+O` 后 `↳` 出现在当时的工具/旁白之间，首行整行 accent，上下带 `│` 空行，和 `›` / `✓` 一眼能分。
6. 闲时新提问、follow-up（终态回答之后的 user）仍新开 Tools。
7. reload / 切回 branch 后，toolResult 之后的 user 仍并入同一 group，计数和 `N steers` 正确。
8. 不改写 Session 消息；切回 `individual` + `/reload` 仍能看到每条原始 user。
9. 现有 aggregate 契约（旁白三行、failed 计数、passthrough、图片 fail-open、session 隔离）不回退。
