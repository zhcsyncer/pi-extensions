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
- `/consult` 选择 panel 模型和 effort、开关 loop gate，并显示预算余量和最近日志。

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
| `/consult status` | Panel、剩余预算、最近日志 |

每次 `consult` 返回后，下一条可见回复应复述 summary，并附一行：

```text
CONSULT-LOG: <why> | <advice> | adopt|reject | <reason>
```

## 配置

全局文件：`$PI_CODING_AGENT_DIR/extension-data/pi-consult/config.json`（通常是 `~/.pi/agent/extension-data/pi-consult/config.json`）。

```json
{
  "panel": [{ "model": "anthropic/claude-fable-5", "effort": "high" }],
  "fanout": false,
  "gates": { "loop": 3 },
  "budget": { "perTurn": 1, "perSession": 8 },
  "disabledForModels": []
}
```

空 `panel` 保持工具卸载。`fanout: true` 时显式 `consult()` 会并行问整组 panel；自动 gate 始终只用第一路。行为日志：`$PI_CODING_AGENT_DIR/extension-data/pi-consult/events.jsonl`。

## 许可证

MIT

侧路调用相关实现改写自 MIT 许可的 [`@juicesharp/rpiv-advisor`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor) 2.8.0。
