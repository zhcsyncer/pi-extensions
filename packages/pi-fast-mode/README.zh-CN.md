# pi-fast-mode

[English](./README.md)

`pi-fast-mode` 会向**同一个模型**请求更高的调度优先级。它不是更快的模型变体，也不是 thinking-level 控制。

## 功能

- 用 `/fast` 或 `Ctrl+F` 开关 Fast / Priority。
- 每个模型的当前开关只存在内存里，不会写入 session jsonl。
- 用 `/fast default on|off` 设置**当前模型**下次进程的默认值。该命令只写 `settings.json`，不改当前开关。
- 没配过的模型默认关闭。没有「所有模型」默认。
- 在支持的模型上显示 footer 状态。不支持的模型隐藏状态，并且不改请求。

## 安装

```bash
pi install npm:@zhcsyncer/pi-fast-mode
# 或通过根 bundle
pi install npm:@zhcsyncer/pi-extensions
# 本地
pi -e ./packages/pi-fast-mode
```

根 Git bundle 也包含这个扩展：

```bash
pi install git:github.com/zhcsyncer/pi-extensions
```

## 命令

```text
/fast
/fast on
/fast off
```

切换或设置**当前**内存开关。`Ctrl+F` 是同一个开关，带短时防抖，按住键不会连续翻转，松开也不会再切换。

```text
/fast default on
/fast default off
```

只写入当前模型的下次默认。当前开关保持不变。当前模型不支持 Fast 时命令失败。

没有 `/fast status` 命令，也没有 `gpt-fast-mode` 兼容别名。

## 设置

默认值按 `provider/id` 存在 Pi `settings.json`。只有写进列表的模型会默认开启：

```json
{
  "fast-mode": {
    "models": {
      "openai/gpt-5.6": true
    }
  }
}
```

`/fast default` 是修改该列表的官方方式。手动编辑会在 `/reload` 或进程重启后生效。旧的 `fast-mode.enabled` 布尔值会被忽略。

## 状态栏

![Fast Mode 底栏状态](./assets/demo-fast-mode-status.png)

- 支持的模型，开启：`⚡ FAST`
- 支持的模型，关闭：暗色 `fast`
- 不支持的模型：隐藏状态，并且不改请求
- `/fast` 和 `Ctrl+F` 只更新底栏。它们不会往聊天记录里加提示。

## 支持的提供商

提供商列表是固定的，没有用户白名单。

- OpenAI 和 Codex 在 Fast Mode 开启时请求 `priority`。
- Pi 内置 xAI 模型已全部使用 Responses，并在 Fast Mode 开启时请求 `priority`。
- `models.json` 里的自定义 xAI Completions 模型仍受支持。

不支持的模型隐藏底栏状态，并且不改请求。

## 价格与计费

不要假设每个模型都会被授予 priority。

- OpenAI Fast / priority 官方定价面向 GPT-5.6 系列。更旧的模型可能拒绝或忽略该请求。
- 对 Responses 模型，Pi 会按响应里的 `service_tier` 计算本地 `usage.cost`：`priority` 通常约为 2 倍，`default` 仍为 1 倍。
- 自定义 xAI Completions 模型可以请求 priority，但本地费用不会获得 Responses 专属的调整。

## Session 生命周期

- `/fast` 和 `Ctrl+F` 只改当前模型的内存开关。
- 换模型跟该模型自己的开关。第一次用到时读它的下次默认；没配过就是关。
- 同一 Pi 进程里的 `/new`、`/resume`、`/fork` 会保留各模型当前开关。
- `/reload` 或进程重启会从 `settings.json` 重新读取按模型默认。
- `/fast default on|off` 只写当前模型的设置默认。
