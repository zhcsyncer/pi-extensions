# @zhcsyncer/pi-meter

[English](./README.md)

面向 [Pi coding agent](https://pi.dev) 的本地用量账本，加上订阅剩余。它分别回答两件事：这个订阅窗口还剩多少，以及本地 token / 费用花在哪。

本包也会嵌入聚合包 `@zhcsyncer/pi-extensions`。

## 安装

单独安装：

```bash
pi install npm:@zhcsyncer/pi-meter
```

或安装完整 extension bundle：

```bash
pi install npm:@zhcsyncer/pi-extensions
```

不安装直接试用：

```bash
pi -e npm:@zhcsyncer/pi-meter
```

## 互斥

**不要**同时加载 `@pi-plugins/usage`。两者都会注册 `/usage`。装好本包后请关掉那个插件。若两者同时在场，pi-meter 会警告一次并继续运行。

`pi-tracker` 可以对照共存，但本包的本地账和套餐剩余都由 `/usage` 接管。

## 命令

| 命令 | 你会看到什么 |
|---|---|
| `/usage` | TUI 菜单：看板、套餐、本地摘要、budget、回填 |
| `/usage quota` | Claude、Codex、SuperGrok 的窗口百分比和重置时间 |
| `/usage quota refresh` | 强制刷新共享快照 |
| `/usage quota used` / `remaining` | 切换底栏套餐半截的已用 / 剩余 |
| `/usage quota on` / `off` | 开关底栏上的套餐半截 |
| `/usage footer` | 本地摘要：今日 token+费用 / 只 token / 只费用 / budget / 主模型 / 关 |
| `/usage import` | 可选、一次性从 session JSONL 回填 |
| `/usage budget` | 本地 token/费用提醒。从不拦请求 |

`--no-session` 和默认内存 sub-agent 只要加载了扩展，就会追加本地账本。`isolated: true` / `extensions: false` 的子代理记不到。

## 常驻 chrome

常驻面是一段底栏 `setStatus`（key 为 `pi-meter`）。不占 widget 整行，也不画进 Glance 输入框内部。窗口名字写在数字前面，避免看不出这是今天花了还是这周还剩：

```text
· today 12.4k $0.18 · week left ███░░ 49% (1d 23h)
```

`today` 是本地花费。`week left` / `5h left` 是当前套餐窗口。颜色按还剩多少高亮（大约剩 30% warning、15% error），即使数字显示的是已用百分比。

## 两套账

远端剩余和本地花费不是同一件事：

- **套餐**来自各家订阅 API，落在共享快照里。不会写入本地用量账本，也不会进入本地 budget。
- **用量**来自 Pi `message_end` 的 usage，按进程追加。`/usage` 的本地半截只看这本账。

SuperGrok 走已验证的 Grok CLI 账单 JSON（`GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`），鉴权用 Pi `/login xai` OAuth。不打 `api.x.ai/v1/api-key`，不接 grok.com gRPC。只展示周池，不单独列出 Build / Chat。

订阅请求只从 `ctx.hasUI === true` 的根会话发出，且只在 `agent_settled`、`/usage quota` 或 `model_select` 时检查。共享 `quota.json` 默认 TTL 60s、最小间隔 30s。没有 UI 的 sub-agent 仍记本地账，但不打订阅 API。

## 存储

全部落在 `$PI_CODING_AGENT_DIR/extension-data/pi-meter/`：

```text
config.json    footer + 套餐偏好
quota.json     共享订阅快照
usage.jsonl    本地账本
budgets.json   本地上限
warned.jsonl   一次性预算警告
```

若已有 pi-tracker 的 `analytics/usage.jsonl`，第一次加载会迁到这个目录。`analytics/footer.json` 和残留的 `footer.json` 会折进 `config.json`。

## 配置

可选 `config.json`：

```json
{
  "footer": {
    "local": "today-spend",
    "quota": true
  },
  "quota": {
    "polarity": "remaining",
    "snapshotTtlMs": 60000,
    "minRefreshIntervalMs": 30000
  }
}
```

`/usage footer` 和 `/usage quota …` 写这份文件。鉴权继续用 Pi `/login`；本包不会打印 token、邮箱或 user id。

## 本地开发

```bash
pnpm --filter @zhcsyncer/pi-meter check
pi --no-extensions -e ./packages/pi-meter --list-models nope
```

## 许可证

MIT
