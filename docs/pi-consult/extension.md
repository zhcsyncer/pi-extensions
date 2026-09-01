# pi-consult

状态：已落地

## 为什么做

主会话已经是强模型。顾问不是更贵的执行层，而是按需、无工具、无用户输出的第二意见：plan / correction / stop。触发不能只靠自觉——loop/fail 和收尾可以观测，方案分叉不能，所以 v0 用 guidelines 的 `why` 承担分叉，用两个 gate 承担卡住和收尾。

不装现成 advisor 包：叙事几乎都是「便宜执行 + 贵顾问」或重编排。要的形状（panel、gate、jsonl）会改到主干，fork 等于重写。

## 心智模型

```text
主模型 ──consult({why})──► 顾问 completeSimple(tools:[]) ──envelope──► tool result
                ▲
                └── loop steer / done followUp 只催这一次调用，不替主模型执行
```

- 顾问看不到用户，也不回传 thinking。
- 自动 gate 强制 panel[0]；`fanout` 只作用于显式 pull。
- 未配 panel：从 active tools 卸掉，prompt 零占用。

## 红线

- 不做 subagent、council/debate、每 turn 后台审、合成模型、CLI backend。
- 失败全部落 tool result，不砸会话。
- jsonl 只记行为字段，不写会话原文。`adopted` 靠后续 `CONSULT-LOG:` 自报回填，可信度有限。
- 配置与日志走仓库统一根：`$PI_CODING_AGENT_DIR/extension-data/pi-consult/`。规格草稿里的 `~/.config/pi-consult/consult.json` 与 `~/.pi/agent/consult/events.jsonl` 不采用，避免和本仓库 extension-data 方案分叉。
