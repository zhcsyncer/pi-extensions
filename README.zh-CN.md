# pi-extensions

[English](./README.md)

zhcsyncer 维护的一组 Pi extensions。

## 包列表

- [`@zhcsyncer/pi-recap`](./packages/pi-recap) — 最近活动回顾扩展，可选同步 Session 标题，并自动命名最近一层 Herdr pane 或 tmux window。
- [`@zhcsyncer/pi-tool-display-intent`](./packages/pi-tool-display-intent) — 紧凑工具展示，支持模型生成的 intent、RPC 可见摘要、可选按用户请求汇总全部工具的 Tools、稳定 `done` 行、自适应 diff 和受限的 Bash 调用预览。

  ![收起的 Tools 账本](./packages/pi-tool-display-intent/assets/demo-aggregate-1.png)

  ![展开的 Tools 时间线](./packages/pi-tool-display-intent/assets/demo-aggregate-2.png)

  ![失败的 Tools 账本](./packages/pi-tool-display-intent/assets/demo-aggregate-3.png)

- [`@zhcsyncer/pi-todo`](./packages/pi-todo) — 周期有界的 Todo overlay：原子多任务 batch、确认后的 `/todo` reset、无依赖图；live 列表只保留当前活动工作，可跨 compact/resume。
- [`@zhcsyncer/pi-glance`](./packages/pi-glance) — `pi-glance` 的维护 fork，保留可组合状态和输入框单槽暂存，并把 Working Tree 计数放进 Git 状态或底边右侧，提供 `/diff` review 以及跟随主题的 Claude-inspired working indicator。

  ![pi-glance demo](./packages/pi-glance/assets/demo.png)

- [`@zhcsyncer/pi-plan-mode`](./packages/pi-plan-mode) — 严格只读规划，支持 revdiff 评审、不可变 revision、紧凑审计展示，以及显式且 branch-aware 的实现/完成生命周期。
- [`@zhcsyncer/pi-search-hub`](./packages/pi-search-hub) — bundle 私有的 `web_search` 和 `web_read` 工具，集成 intent-aware 展示。
- [`@zhcsyncer/pi-context7`](./packages/pi-context7) — Context7 `resolve-library-id` / `query-docs` 工具，自包含紧凑 TUI 渲染，并附带完整 `context7-docs` Skill。
- [`@zhcsyncer/pi-ask-user-question`](./packages/pi-ask-user-question) — 结构化澄清问答，采用非浮层布局，支持上下文感知的数字键直选、居中预览和可读的交互后结果。
- [`@zhcsyncer/pi-herdr-companion`](./packages/pi-herdr-companion) — Herdr 集成，提供跨 Workspace 托管进程身份、可导航 Process Widget、紧凑 Tool 渲染、临时 `/btw` 支线、blocked 状态和统一设置；需单独安装，根 bundle 不会启用。
- [`@zhcsyncer/pi-subagents`](./packages/pi-subagents) — `@tintinweb/pi-subagents` 维护 fork：摘要 ConversationViewer + 可折叠 tool TUI（model/effort）。也嵌入根 bundle。
- [`@zhcsyncer/pi-fast-mode`](./packages/pi-fast-mode) — 同一模型的 Fast / Priority 调度，面向 OpenAI 与 xAI，内存开关为 `/fast` 和 Ctrl+F。

  ![Fast Mode 底栏状态](./packages/pi-fast-mode/assets/demo-fast-mode-status.png)

- [`@zhcsyncer/pi-meter`](./packages/pi-meter) — 一条 `/usage` 同时看本地花费和 Claude / Codex / SuperGrok / Ollama Cloud 剩余。合了 `pi-tracker` 与 `@pi-plugins/usage`；不要同时加载后者，两者都会注册 `/usage`。

  ![Meter 底栏](./packages/pi-meter/assets/demo-meter-status.png)

  ![套餐看板](./packages/pi-meter/assets/demo-quota-dashboard.png)

## 说明

Search Hub 只随根 bundle 提供。不要把 `@tintinweb/pi-subagents` 和 `pi-subagents` 一起加载，也不要把 `@pi-plugins/usage` 和 `pi-meter` 一起加载。

## 独立 Providers

以下 provider 不进入根 bundle。Cursor Ask 只保留在仓库源码中，不发布到 npm；Agent Plan 独立发版。

- [`pi-provider-cursor-ask`](./providers/pi-provider-cursor-ask) — `@rahularya01/pi-cursor` 的整仓替代版，保留 `cursor` provider/登录身份，提供 4 行始终开启 thinking 的 1M Fable/Opus/Sonnet 模型及 Composer 2.5 / Fast。
- [`pi-provider-volcengine-agent-plan`](./providers/pi-provider-volcengine-agent-plan) — 非官方火山方舟 Agent Plan provider，支持按套餐过滤模型和 Pi 登录。

```bash
# 在本仓库的本地 checkout 中执行
pi install ./providers/pi-provider-cursor-ask

pi install npm:pi-provider-volcengine-agent-plan
```

## 从 Git 安装

从本仓库安装完整 extension bundle：

```bash
pi install git:github.com/zhcsyncer/pi-extensions
```

不安装直接试用：

```bash
pi -e git:github.com/zhcsyncer/pi-extensions
```

## 从 npm 安装

安装包含 Glance、Plan Mode、Context7、Subagents、Fast Mode、Meter、结构化用户问答，以及私有 Search Hub fork 的完整 bundle：

```bash
pi install npm:@zhcsyncer/pi-extensions
```

仅安装 recap：

```bash
pi install npm:@zhcsyncer/pi-recap
```

仅安装 intent-aware tool display：

```bash
pi install npm:@zhcsyncer/pi-tool-display-intent
```

仅安装 Todo：

```bash
pi install npm:@zhcsyncer/pi-todo
```

仅安装 Glance：

```bash
pi install npm:@zhcsyncer/pi-glance
```

仅安装严格 Plan Mode：

```bash
pi install npm:@zhcsyncer/pi-plan-mode
```

仅安装 Context7 文档工具：

```bash
pi install npm:@zhcsyncer/pi-context7
```

仅安装结构化问答：

```bash
pi install npm:@zhcsyncer/pi-ask-user-question
```

安装 standalone Herdr companion（根 bundle 不自动启用）：

```bash
pi install npm:@zhcsyncer/pi-herdr-companion
```

仅安装 Subagents：

```bash
pi install npm:@zhcsyncer/pi-subagents
```

仅安装 Fast Mode：

```bash
pi install npm:@zhcsyncer/pi-fast-mode
```

仅安装 Meter：

```bash
pi install npm:@zhcsyncer/pi-meter
```

## 发版

每个用户可见的 pull request 都要添加 changeset：

```bash
pnpm changeset
```

公开包独立管理版本。根 tarball 会内嵌子包源码，因此子包发生变更时，同一 release plan 必须包含聚合根包；未变更的其他子包无需发版。推送带发版计划的变更前，必须先向用户展示计划更新的包和目标版本并等待 review。获批变更进入 `main` 后，GitHub Actions 会创建 version PR；合并已审核的 version PR 后才会发布计划中的 package 并创建 GitHub Releases。完整流程和 npm/GitHub 一次性配置见 [RELEASING.md](./RELEASING.md)。

## 许可证

MIT

`pi-tool-display-intent` 修改自 MIT 许可的 [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display) 0.5.0，并改编了 MIT 许可的 [`mertdeveci5/pi-tool-display-summary`](https://github.com/mertdeveci5/pi-tool-display-summary) 0.1.0 中的 `displaySummary` 机制。完整归属和保留声明见 [`packages/pi-tool-display-intent/README.md`](./packages/pi-tool-display-intent/README.md)、[`LICENSE`](./packages/pi-tool-display-intent/LICENSE) 和 [`UPSTREAM_LICENSE`](./packages/pi-tool-display-intent/UPSTREAM_LICENSE)。

`pi-todo` fork 自 MIT 许可的 [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) 1.20.0。准确 revision 和保留声明见 [`packages/pi-todo/UPSTREAM_SOURCE.md`](./packages/pi-todo/UPSTREAM_SOURCE.md)、[`LICENSE`](./packages/pi-todo/LICENSE) 和 [`UPSTREAM_LICENSE`](./packages/pi-todo/UPSTREAM_LICENSE)。

`pi-glance` fork 自 MIT 许可的 [`LinYS77/pi-glance`](https://github.com/LinYS77/pi-glance) 0.5.3。准确 revision 和保留声明见 [`packages/pi-glance/UPSTREAM_SOURCE.md`](./packages/pi-glance/UPSTREAM_SOURCE.md)、[`LICENSE`](./packages/pi-glance/LICENSE) 和 [`UPSTREAM_LICENSE`](./packages/pi-glance/UPSTREAM_LICENSE)。

`pi-search-hub` fork 自 [`ronnieops/pi-search-hub`](https://github.com/ronnieops/pi-search-hub) 2.8.0，其 package metadata 和 README 声明为 MIT。准确 revision 和保留声明见 [`packages/pi-search-hub/UPSTREAM_SOURCE.md`](./packages/pi-search-hub/UPSTREAM_SOURCE.md) 与 [`UPSTREAM_NOTICE.md`](./packages/pi-search-hub/UPSTREAM_NOTICE.md)。

`pi-context7` fork 自 MIT 许可的 [`@upstash/context7-pi`](https://github.com/upstash/context7) 0.1.2（`b250c2515694eee4b6df4db82fa056df9ed3e306`）。准确 revision 和保留声明见 [`packages/pi-context7/UPSTREAM_SOURCE.md`](./packages/pi-context7/UPSTREAM_SOURCE.md)、[`LICENSE`](./packages/pi-context7/LICENSE) 与 [`UPSTREAM_LICENSE`](./packages/pi-context7/UPSTREAM_LICENSE)。

`pi-ask-user-question` fork 自 MIT 许可的 [`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) 2.4.0。准确 revision 和保留声明见 [`packages/pi-ask-user-question/UPSTREAM_SOURCE.md`](./packages/pi-ask-user-question/UPSTREAM_SOURCE.md)、[`LICENSE`](./packages/pi-ask-user-question/LICENSE) 与 [`UPSTREAM_LICENSE`](./packages/pi-ask-user-question/UPSTREAM_LICENSE)。

`pi-subagents` fork 自 MIT 许可的 [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) 0.14.3（`c10b1836256e760da75296ccd4e57a77ada1325e`）。准确 revision、本地 UI 差异与保留声明见 [`packages/pi-subagents/UPSTREAM_SOURCE.md`](./packages/pi-subagents/UPSTREAM_SOURCE.md)、[`LICENSE`](./packages/pi-subagents/LICENSE) 与 [`UPSTREAM_LICENSE`](./packages/pi-subagents/UPSTREAM_LICENSE)。

`pi-herdr-companion` 改编了 MIT 许可 [`pi-herdr-btw`](https://github.com/oscabriel/pi-herdr-btw) 0.3.0 的 `/btw` 行为与私有 mailbox 模式。准确 tarball 来源与保留声明见 [`packages/pi-herdr-companion/UPSTREAM_SOURCE.md`](./packages/pi-herdr-companion/UPSTREAM_SOURCE.md)、[`LICENSE`](./packages/pi-herdr-companion/LICENSE) 与 [`UPSTREAM_LICENSE`](./packages/pi-herdr-companion/UPSTREAM_LICENSE)。

`pi-provider-cursor-ask` fork 自 MIT 许可的 [`@rahularya01/pi-cursor`](https://github.com/Rahularya01/pi-cursor) 1.4.25（`5f8e775279f5e41cdd06791a036be4c7141097c3`）。准确 revision、独立身份与目录差异、保留声明见 [`providers/pi-provider-cursor-ask/UPSTREAM_SOURCE.md`](./providers/pi-provider-cursor-ask/UPSTREAM_SOURCE.md) 和 [`LICENSE`](./providers/pi-provider-cursor-ask/LICENSE)。
