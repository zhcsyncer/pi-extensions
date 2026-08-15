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

`pi-tracker` 可以对照共存，但本包的本地账本由 `/analytics` 和 `/budget` 接管。

## 命令

| 命令 | 你会看到什么 |
|---|---|
| `/usage` | Claude、Codex、SuperGrok 的窗口百分比和重置时间 |
| `/usage refresh` | 强制刷新共享快照（仍遵守 30s 最小间隔） |
| `/usage used` / `/usage remaining` | 把常驻条在「已用 / 剩余」之间切换 |
| `/analytics` | 按 model / project / session 看本地账，含 input / output / cache 列 |
| `/analytics import` | 可选、一次性从 session JSONL 回填 |
| `/analytics details` | 开关常驻行上的 input / output / cache hit |
| `/budget` | 本地 token/费用提醒。从不拦请求 |

`--no-session` 和默认内存 sub-agent 只要加载了扩展，就会追加本地账本。`isolated: true` / `extensions: false` 的子代理记不到。

## 常驻 chrome

常驻面是输入框**下方**一整行 `setWidget`。它和 Glance 完全独立：不读 Glance 配置、不用 `setStatus`、也不会画进 Glance 输入框内部。

```text
  12.4k  $0.18          ╶───╸──╴ 66% · 3d
```

打开 token 细节后：

```text
  ↑12.4k ↓2.1k hit 80k  ╶───╸──╴ 66% · 3d
```

变窄时先丢掉 token 细节，再丢掉总量/费用，最后留套餐条。颜色按还剩多少高亮（大约剩 30% warning、15% error），即使数字显示的是已用百分比。

## 两套账

远端剩余和本地花费不是同一件事：

- **套餐**来自各家订阅 API，落在共享快照里。不会写入本地用量账本，也不会进入本地 budget。
- **账本**来自 Pi `message_end` 的 usage，按进程追加。`/analytics` 和 `/budget` 只看这本账。

SuperGrok 走已验证的 Grok CLI 账单 JSON（`GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`），鉴权用 Pi `/login xai` OAuth。不打 `api.x.ai/v1/api-key`，不接 grok.com gRPC。Build / Chat 拆分只出现在 `/usage`，不塞进常驻那一行。

订阅请求只从 `ctx.hasUI === true` 的根会话发出，且只在 `agent_settled`、`/usage` 或 `model_select` 时检查。共享 `quota.json` 默认 TTL 60s、最小间隔 30s。没有 UI 的 sub-agent 仍记本地账，但不打订阅 API。

## 存储

全部落在 `$PI_CODING_AGENT_DIR/extension-data/pi-meter/`：

```text
config.json    极性、token 细节、TTL
quota.json     共享订阅快照
usage.jsonl    本地账本
budgets.json   本地上限
warned.jsonl   一次性预算警告
```

若已有 pi-tracker 的 `analytics/usage.jsonl`，第一次加载会迁到这个目录。

## 配置

可选 `config.json`：

```json
{
  "quotaPolarity": "remaining",
  "tokenDetails": false,
  "snapshotTtlMs": 60000,
  "minRefreshIntervalMs": 30000
}
```

极性和 token 细节也可由命令写入。鉴权继续用 Pi `/login`；本包不会打印 token、邮箱或 user id。

## 本地开发

```bash
pnpm --filter @zhcsyncer/pi-meter check
pi --no-extensions -e ./packages/pi-meter --list-models nope
```

## 许可证

MIT
