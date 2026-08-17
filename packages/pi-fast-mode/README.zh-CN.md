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

- 支持的模型，开启：`⚡ FAST` 加上 `priority if granted`
- 支持的模型，关闭：暗色 `fast: off · Ctrl+F`
- 不支持的模型：隐藏状态，并且不改请求

## 支持的提供商

提供商列表是写死的，没有用户白名单。

- `openai` + `openai-responses` 通过 `registerProvider` 和 `options.serviceTier = "priority"`
- `openai-codex` + `openai-codex-responses` 同样如此
- `xai` + `openai-responses` / `openai-completions` 通过 `before_provider_request` 的 payload `service_tier: "priority"`

OpenAI 和 Codex 继续走 Pi 内置 `streamSimple` 的 options 收口，包括默认 `maxTokens` 和剩余上下文 clamp，只在 Fast Mode 开启时加 `serviceTier`。没有额外的 32k 上限。

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

## 开发

```bash
pnpm --filter @zhcsyncer/pi-fast-mode check
```

扩展不能导入 `@earendil-works/pi-ai/api/*`。Pi 的加载器会把 `@earendil-works/pi-ai` 指到 `compat.js`，这些深路径在加载时会失败。`extensions/stream-options.ts` 因此本地保留一份 `streamSimple` 的 options 收口。

包测试会对照这份本地收口和已安装的 `@earendil-works/pi-ai` helper，也会检查 OpenAI 和 Codex 的 `streamSimple` 源码。升级 Pi 后请跑这项检查。如果失败，重新阅读这些函数；只有原厂配方增加了新字段时，才更新本地收口。
