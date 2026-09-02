# pi-provider-cursor-ask

[English](./README.md)

一个独立的 [Pi](https://github.com/badlogic/pi-mono) provider，通过 Cursor 服务于聚焦的 advisor、adversarial-review 和单轮问答工作流。

这是非官方社区 fork，与 Cursor 及上游项目没有隶属关系，也未获得其官方背书。

## 来源与差异

本包整仓 fork 自 [`@rahularya01/pi-cursor`](https://github.com/Rahularya01/pi-cursor) `v1.4.25`（`5f8e775279f5e41cdd06791a036be4c7141097c3`）。保留上游原生 Cursor OAuth、凭证发现、流式响应、工具调用、图片输入、用量、诊断和模型发现能力。

本 fork 的用户可见差异如下：

- 使用与上游相同的 `cursor` provider/登录身份和 `cursor-native` stream API 直接替换旧扩展。
- 不展示完整 Cursor 目录，只提供 5 行始终开启 thinking 的 1M Claude 模型，以及 Composer 2.5 / Composer 2.5 Fast；过滤其他所有模型系列。
- Picker 不再拆默认上下文行：Cursor 对这些 Claude 模型按同一费率计到 1M。
- 只映射明确提供的 Pi thinking 档位。Claude 映射 Cursor `effort`。Composer 2.5 没有 effort 参数，因此只用 `off`/`max` 显式开关 Max Mode，其余档位保持不可用。
- 只保留在本仓库源码中，不发布到 npm，也不进入 `@zhcsyncer/pi-extensions` 根 bundle。

维护中的 fork 来源记录见 [`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md)。

## 模型

- Fable 5.1
- Fable 5
- Opus 5
- Opus 4.6
- Sonnet 5
- Composer 2.5 / Composer 2.5 Fast

5 行 Claude 模型的 Thinking 无法关闭。根据 Cursor 为各 Claude 模型返回的 metadata，Pi 可能提供 `low`、`medium`、`high`、`xhigh` 和 `max`；不可用的档位不会显示。Composer 2.5 只提供 `off`（标准）和 `max`（Max Mode）。

## 要求

- Node.js 22.19 或更高版本。
- Pi 0.80 或兼容的更新版本。
- 有权使用所选模型的 Cursor 账号。

## 安装

在本仓库的本地 checkout 中执行：

```bash
pi install /absolute/path/to/pi-extensions/providers/pi-provider-cursor-ask
```

重启 Pi 或执行 `/reload`，然后登录：

```text
/login cursor
```

Provider 也可以复用受支持的 Cursor CLI 或桌面端凭证。自动化环境可设置 `CURSOR_ACCESS_TOKEN`。

## 使用

列出过滤后的模型：

```bash
pi --list-models cursor
```

可选择 `cursor/fable-5.1`、`cursor/fable-5`、`cursor/opus-5`、`cursor/opus-4.6` 或 `cursor/sonnet-5`。

可用命令：

- `/cursor usage` — 打开 Cursor 套餐用量面板。
- `/cursor doctor` — 打开脱敏后的 provider 诊断面板。

若同时加载了 `@zhcsyncer/pi-meter`，底栏会跟当前 Cursor 模型走：Composer 看 Auto 池，Claude 行看 API 池。

本包有意占用 `cursor` provider id，作为旧扩展的直接替代品。不要与 `@rahularya01/pi-cursor` 同时加载；后注册的扩展会覆盖另一方的 `cursor` 模型目录。

## 安全

本 fork 保留上游读取本地 Cursor CLI/桌面端凭证及复用 Pi 现有 `cursor` 凭证条目的能力。若要禁用本地凭证发现，请在启动 Pi 前设置 `PI_CURSOR_SYSTEM_CREDENTIALS=0`，并改用 `/login cursor` 或 `CURSOR_ACCESS_TOKEN`。

Extension 以当前用户权限运行。安装前请审查代码，不要提交凭证，也不要把凭证粘贴进 issue。

## 许可证

MIT。上游版权和许可证声明保留在 [`LICENSE`](./LICENSE)。
