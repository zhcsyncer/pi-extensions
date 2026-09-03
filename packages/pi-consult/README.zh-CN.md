# @zhcsyncer/pi-consult

[English](./README.md)

面向 [Pi coding agent](https://pi.dev) 的第二意见原语。主模型调用 `consult({ why })`；无工具的顾问模型返回 plan / correction / stop。loop gate 可以强制这次调用。可选双路 panel。本地行为日志。

本包也包含在 `@zhcsyncer/pi-extensions` 里。

## 来源

新包。侧路调用、工具清单前缀和 active-tool 调和改写自 MIT 许可的 [`@juicesharp/rpiv-advisor`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor) 2.8.0。工具名是 `consult`（必填 `why`），配置是 panel 数组，并加上 loop gate、预算和本地 jsonl 日志。不是 fork。

## 功能

- `consult({ why })` 把当前会话转给已配置的顾问。顾问没有工具，也不对用户说话。
- 未配置 panel 时卸载该工具。关掉零占用。
- Loop gate：连续 N 次相同工具调用或连续 N 次 error 后，steer 先 consult。
- `/consult` 选择 panel 模型和 effort、开关 loop gate。`/consult status` 用临时 dashboard 展示预算和最近活动，不向 transcript 添加任何内容。
- 顾问用量包含重试、fanout、cache read/write 与费用，并附在 Consult tool result 上，因此 Pi session 总量会计入；dashboard 的最近记录会显示缓存命中率。

## 安装

单独安装：

```bash
pi install npm:@zhcsyncer/pi-consult
```

或安装完整扩展 bundle：

```bash
pi install npm:@zhcsyncer/pi-extensions
```

不安装先试用：

```bash
pi -e npm:@zhcsyncer/pi-consult
```

然后重启 Pi 或运行 `/reload`。用 `/consult` 选择顾问模型。未设置 panel 时，`consult` 不在 active tools 里。

## 命令

| 命令 | 你会看到 |
|---|---|
| `/consult` | Panel、effort、fanout、loop gate |
| `/consult status` | 临时展示 panel、剩余预算和最近活动；按 `q`/Esc 关闭，不写入 transcript |

每次 `consult` 返回后，下一条可见回复应附一行：

```text
CONSULT-LOG: adopt|reject | <reason>
```

该行仍按普通 assistant 输出展示，其决定也会镜像到对应的 Consult 行下。TUI 会区分 `consulting`、顾问反馈类型、策略 `blocked`、请求 `failed` 与用户 `cancelled` 状态。

## 配置

全局文件：`$PI_CODING_AGENT_DIR/extension-data/pi-consult/config.json`（通常是 `~/.pi/agent/extension-data/pi-consult/config.json`）。

```json
{
  "panel": [{ "model": "anthropic/claude-fable-5", "effort": "high" }],
  "fanout": false,
  "gates": { "loop": 3 },
  "budget": { "perRun": 3, "perSession": 8 },
  "disabledForModels": []
}
```

空 `panel` 保持工具卸载。`fanout: true` 时显式 `consult()` 会并行问整组 panel；自动 gate 始终只用第一路。`perRun` 从一次真实用户输入开始，覆盖其后的所有模型/工具轮次，并在下一次用户输入时重置。预算按已开始的顾问请求计数，包括之后失败或取消的尝试；旧 `perTurn` 仍作为兼容别名。行为日志：`$PI_CODING_AGENT_DIR/extension-data/pi-consult/events.jsonl`。

## 许可证

MIT

侧路调用相关实现改写自 MIT 许可的 [`@juicesharp/rpiv-advisor`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor) 2.8.0。
