# @zhcsyncer/pi-meter

[English](./README.md)

面向 [Pi coding agent](https://pi.dev) 的用量仪表。一条 `/usage` 分别回答两件事：这个订阅窗口还剩多少，以及本地 token / 费用花在哪。

本包也包含在 `@zhcsyncer/pi-extensions` 里。

## 来源

本包把两个现成的 Pi 扩展合在一起：

| 来源 | 你已经熟悉的部分 | 本包改了什么 |
|---|---|---|
| [`pi-tracker`](https://github.com/alpertarhan/pi-tracker) | 本地 token/费用账本、看板、budget、session 回填 | 这些都在 `/usage` 下，不再用 `/analytics`。数字写成 `34k` / `4.3M` / `5.35B`。 |
| [`@pi-plugins/usage`](https://github.com/k3dom/pi-plugins/tree/main/plugins/usage) | Claude、Codex 订阅窗口 | 这些都在 `/usage quota` 下。另外加上 SuperGrok 和 Ollama Cloud。 |

**不要**同时加载 `@pi-plugins/usage`。两者都会注册 `/usage`。若两者同时在场，本包会警告一次并继续运行。

`pi-tracker` 可以对照共存，但 `/usage` 由本包接管。

## 功能

- 底栏同时显示过去 24 小时的本地花费和当前模型对应的订阅窗口：

  ```text
  · 24h 12.4k $0.18 · xai week left ███░░ 49% (1d 23h)
  ```

  ![Meter 底栏](./assets/demo-meter-status.png)

- 按模型、项目或 session 看本地看板，含 cache write。
- `/login` 对应账号后，可看 Claude、Codex、SuperGrok、Ollama Cloud 剩余。
- `/usage quota` 打开临时看板。未登录的提供商收在底部一条淡提示。当前模型没有窗口、没登录或这次没拉到时，底栏只给短提示，不会画别家额度。
- 其他扩展可以登记配额源。底栏仍然只跟当前模型走。
- 可选本地 budget。只会提醒，从不拦请求。
- 可选从旧 session 文件回填。可重复执行：已经记过的回合不会再计一次。

  ![套餐看板](./assets/demo-quota-dashboard.png)

`--no-session` 和普通 sub-agent 仍会记本地账。隔离的子代理记不到。

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

然后重启 Pi，或执行 `/reload`。若 `settings.json` 里已有 `@pi-plugins/usage`，请先去掉。

## 命令

| 命令 | 你会看到什么 |
|---|---|
| `/usage` | 菜单：看板、套餐、底栏、budget、回填 |
| `/usage quota` | 打开 Claude、Codex、SuperGrok、Ollama Cloud 的剩余额度与重置时间看板 |
| `/usage quota refresh` | 刷新订阅窗口并打开看板 |
| `/usage footer` | 配置本地摘要、滚动/日历窗口、配额显示开关以及已用/剩余模式 |
| `/usage import` | 从 session 文件回填，不会把已捕获的回合再记一遍 |
| `/usage budget` | 查看或添加本地 budget |

## 许可证

MIT

本地账本来自 MIT 许可的 [`pi-tracker`](https://github.com/alpertarhan/pi-tracker)。订阅窗口来自 MIT 许可的 [`@pi-plugins/usage`](https://github.com/k3dom/pi-plugins/tree/main/plugins/usage)。
