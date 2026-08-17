# pi-fast-mode

[English](./README.md)

`pi-fast-mode` 会向**同一个模型**请求更高的调度优先级。它不是更快的模型变体，也不是 thinking-level 控制。

## 功能

- 用 `/fast` 或 `Ctrl+F` 开关 Fast / Priority。
- 当前开关只存在内存里，不会写入 session jsonl。
- 用 `/fast default on|off` 设置下次进程的默认值。该命令只写 `settings.json`，不改当前开关。
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

只写入 `settings.json` 的 `fast-mode.enabled`。当前开关保持不变。

没有 `/fast status` 命令，也没有 `gpt-fast-mode` 兼容别名。

## 设置

支持的设置键是 Pi `settings.json` 里的 `fast-mode.enabled`：

```json
{
  "fast-mode": {
    "enabled": false
  }
}
```

`/fast default` 是修改该字段的官方方式。手动编辑会在 `/reload` 或进程重启后生效。

## 状态栏

![Fast Mode 底栏状态](./assets/demo-fast-mode-status.png)

- 支持的模型，开启：`⚡ FAST` 加上 `priority if granted`
- 支持的模型，关闭：暗色 `fast: off · Ctrl+F`
- 不支持的模型：隐藏状态，并且不改请求

## 支持的提供商

提供商列表是固定的，没有用户白名单。

- OpenAI 和 Codex 在 Fast Mode 开启时请求 `priority`。
- xAI 在 Fast Mode 开启时请求 `priority`。

不支持的模型隐藏底栏状态，并且不改请求。

## 价格与计费

不要假设每个模型都会被授予 priority，也不要假设本地费用总是大约 2 倍。

- OpenAI Fast / priority 官方定价面向 GPT-5.6 系列。更旧的模型可能拒绝或忽略该请求。
- xAI 可能返回 `service_tier: "default"`。
- Completions（当前 grok-4.6）不会把 priority 反映到本地 `usage.cost`。Glance 和 session 费用可能偏低。

## Session 生命周期

- `/fast` 和 `Ctrl+F` 只改内存开关。
- 同一 Pi 进程里的 `/new`、`/resume`、`/fork` 会保留当前开关。
- `/reload` 或进程重启会从 `settings.json` 重新读取 `fast-mode.enabled`。
- `/fast default on|off` 只写设置里的默认值。
