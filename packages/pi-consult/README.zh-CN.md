# @zhcsyncer/pi-consult

[English](./README.md)

面向 [Pi coding agent](https://pi.dev) 的第二意见原语。主模型调用 `consult({ why })`；无工具的顾问模型返回 recommend / confirm / revise / stop。watchdog 可在重复失败后强制这次调用。可选双路 panel。本地行为日志。

本包也包含在 `@zhcsyncer/pi-extensions` 里。

## 来源

新包。侧路调用、工具清单前缀和 active-tool 调和改写自 MIT 许可的 [`@juicesharp/rpiv-advisor`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor) 2.8.0。工具名是 `consult`（必填 `why`），配置是 panel 数组，并加上 watchdog、预算和本地 jsonl 日志。不是 fork。

## 功能

- `consult({ why })` 把当前会话转给已配置的顾问。顾问没有工具，也不对用户说话。
- 主动 Consult 仅用于用户明确要求顾问、后果重大的证据未决结构选择，或真正卡住的方案。已拍板、可逆、机械和只需主模型直接判断的工作不 Consult；有证据时拒绝顾问是正常结果。
- 未配置 panel 时卸载该工具。关掉零占用。
- Watchdog：连续 N 次相同工具调用或连续 N 次 error 后，steer 先 consult。默认阈值为 5；Consult 完成后清空此前的证据。
- `/consult` 选择 panel 模型和 effort、开关 watchdog。`/consult status` 用临时 dashboard 展示预算和最近活动，不向 transcript 添加任何内容。
- 顾问 summary 跟随用户最近一条实质性请求的语言，同时保留技术语法。展开态渲染 Markdown；折叠态保持干净的单行预览。
- 等待行实时显示 `connecting` / `thinking` / `writing` 和估算的 `~out`；完成后的展开态与 status dashboard 只显示精确 input、output 和 total tokens。
- 完整顾问用量仍包含重试、fanout、cache read/write 与费用，并附在 Consult tool result 上供 Pi/pi-meter 统计；Consult UI 不展示 cache 和费用。

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
| `/consult` | Panel、effort、fanout、watchdog |
| `/consult status` | 临时展示 panel、剩余预算和最近活动；按 `q`/Esc 关闭，不写入 transcript |

每次 `consult` 返回后，下一条可见回复应附一行：

```text
CONSULT-LOG: adopt | changed: <reason>
CONSULT-LOG: adopt | confirmed: <reason>
CONSULT-LOG: reject | <reason>
```

该行仍按普通 assistant 输出展示，其决定也会镜像到对应的 Consult 行下。TUI 会区分流式 `connecting` / `thinking` / `writing`、顾问反馈类型、策略 `blocked`、请求 `failed` 与用户 `cancelled` 状态。

## 配置

全局文件：`$PI_CODING_AGENT_DIR/extension-data/pi-consult/config.json`（通常是 `~/.pi/agent/extension-data/pi-consult/config.json`）。

```json
{
  "panel": [{ "model": "anthropic/claude-fable-5", "effort": "high" }],
  "fanout": false,
  "gates": { "watchdog": 5 },
  "budget": { "perRun": 3, "perSession": 8 },
  "disabledForModels": []
}
```

空 `panel` 保持工具卸载。`fanout: true` 时 on-demand `consult()` 会并行问整组 panel；watchdog 始终只用第一路。`perRun` 从一次真实用户输入开始，覆盖其后的所有模型/工具轮次，并在下一次用户输入时重置。预算按已开始的顾问请求计数，包括之后失败或取消的尝试；旧 `perTurn` 仍作为兼容别名。行为日志：`$PI_CODING_AGENT_DIR/extension-data/pi-consult/events.jsonl`。每次调用记录 `session + toolCallId`、outcome、trigger、verdict、usage，以及后续 changed / confirmed / rejected 效果，用于关联 transcript 做事后整体评估。

## 许可证

MIT

侧路调用相关实现改写自 MIT 许可的 [`@juicesharp/rpiv-advisor`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor) 2.8.0。
