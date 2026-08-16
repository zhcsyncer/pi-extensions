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
- [`@zhcsyncer/pi-glance`](./packages/pi-glance) — `pi-glance` 的维护 fork，保留可组合状态，并把 Working Tree 计数放进 Git 状态或底边右侧，提供 `/diff` review 以及跟随主题的 Claude-inspired working indicator。

  ![pi-glance demo](./packages/pi-glance/assets/demo.png)

- [`@zhcsyncer/pi-plan-mode`](./packages/pi-plan-mode) — 严格只读规划，支持 revdiff 评审、不可变 revision、紧凑审计展示，以及显式且 branch-aware 的实现/完成生命周期。
- [`@zhcsyncer/pi-search-hub`](./packages/pi-search-hub) — bundle 私有的 `web_search` 和 `web_read` 工具，集成 intent-aware 展示。
- [`@zhcsyncer/pi-context7`](./packages/pi-context7) — Context7 `resolve-library-id` / `query-docs` 工具，自包含紧凑 TUI 渲染，并附带完整 `context7-docs` Skill。
- [`@zhcsyncer/pi-ask-user-question`](./packages/pi-ask-user-question) — 结构化澄清问答，采用非浮层布局，支持上下文感知的数字键直选、居中预览和可读的交互后结果。
- [`@zhcsyncer/pi-subagents`](./packages/pi-subagents) — `@tintinweb/pi-subagents` 维护 fork：摘要 ConversationViewer + 可折叠 tool TUI（model/effort）。也嵌入根 bundle。
- [`@zhcsyncer/pi-fast-mode`](./packages/pi-fast-mode) — 同一模型的 Fast / Priority 调度，面向 OpenAI 与 xAI，内存开关为 `/fast` 和 Ctrl+F。
- [`@zhcsyncer/pi-meter`](./packages/pi-meter) — 一条 `/usage` 同时看本地花费和 Claude / Codex / SuperGrok 剩余。合了 `pi-tracker` 与 `@pi-plugins/usage`；不要同时加载后者，两者都会注册 `/usage`。

## Bundle 私有 Search Hub

聚合包 `@zhcsyncer/pi-extensions` 内置私有 Search Hub fork，并注册其 `web_search` 和 `web_read` 工具。Search Hub 不作为独立 npm 包发布；需要安装根 bundle 才能使用。

该 fork 保留上游多后端搜索和页面提取能力，同时集成模型生成的 `displaySummary` intent、语义化 query/URL 调用行、backend 和 reader 状态，以及共享的工具结果展示模式。配置与本地行为详见 [Search Hub 中文文档](./packages/pi-search-hub/README.zh-CN.md) 或其 [英文版本](./packages/pi-search-hub/README.md)。

## Context7

`@zhcsyncer/pi-context7` 是维护中的 Context7 文档工具 fork。可以单独安装，也可以通过根 bundle 使用；根 bundle 会嵌入并注册同一扩展与 Skill。

该 fork 保留上游工具描述、面向模型的结果文本和完整 Skill，同时加入本地紧凑 `renderCall` / `renderResult` 行、AbortSignal 感知的 fetch，以及非 2xx HTTP 抛错以便 Pi 正确标记 tool error。更高配额请设置 `CONTEXT7_API_KEY`。详见 [Context7 中文文档](./packages/pi-context7/README.zh-CN.md) 或其 [英文版本](./packages/pi-context7/README.md)。

## Subagents

`@zhcsyncer/pi-subagents` 是 [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) 0.14.3 的维护 fork。可单独安装，也可通过根 bundle 使用；根 bundle 会嵌入并注册同一扩展。上游运行时（Agent / steer / resume / FleetView / 通知）不变；本 fork 主要改 **进展怎么显示**：

- 对话 overlay 默认 **Prompt · 一行 Steps · Result**（不再 dump 整墙 toolResult）
- 主 transcript tool 行可折叠；展开为 Markdown；调用/结果行显示 **model** 与 **effort**

**不要**与 `@tintinweb/pi-subagents` 同时加载（会双注册 `Agent` / FleetView）。上游钉扎与差异清单：[`packages/pi-subagents/UPSTREAM_SOURCE.md`](./packages/pi-subagents/UPSTREAM_SOURCE.md)。对比表默认英文：[package README](./packages/pi-subagents/README.md) / [简体中文](./packages/pi-subagents/README.zh-CN.md)。

## 扩展持久化数据

Bundle 内所有独立配置现统一使用 `$PI_CODING_AGENT_DIR/extension-data/<extension-id>/config.json`，包括 Todo、Ask User Question、Subagents 与 Meter。旧文件会原子迁移，并在删除前完成验证；canonical 数据优先，格式损坏或冲突的旧文件会保留并提示 warning。Recap 与 Search Hub 在受信任项目中的覆盖配置使用 `<cwd>/<CONFIG_DIR_NAME>/extension-data/<extension-id>/config.json`；Subagents 保留原有项目覆盖全局行为，使用对应项目路径，并把可选 `agent-tool-description.md` 放在 `config.json` 同目录。Meter 的本地账本和共享订阅快照也落在 `extension-data/pi-meter/`，首次加载会迁走 `analytics/usage.jsonl`。本次只迁移配置，不移动自定义 agent、skill、Pi `settings.json` 或 `auth.json`、memory、schedule、transcript、session 状态与 Plan artifact；它们继续使用原有 resource/state 位置，包括 `$PI_CODING_AGENT_DIR/plans/`。

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

## 开发

测试根 bundle：

```bash
pi -e . --list-models nope
```

直接测试单个 package：

```bash
pi -e ./packages/pi-recap --list-models nope
pi --no-extensions -e ./packages/pi-tool-display-intent
pi --no-extensions -e ./packages/pi-todo --list-models nope
pi --no-extensions -e ./packages/pi-glance
pi --no-extensions -e ./packages/pi-plan-mode --list-models nope
pi --no-extensions -e ./packages/pi-search-hub --list-models nope
pi --no-extensions -e ./packages/pi-context7 --list-models nope
pi --no-extensions -e ./packages/pi-ask-user-question --list-models nope
pi --no-extensions -e ./packages/pi-subagents --list-models nope
pi --no-extensions -e ./packages/pi-fast-mode --list-models nope
pi --no-extensions -e ./packages/pi-meter --list-models nope
```

测试 `pi-tool-display-intent` 时，不要同时加载原始 `pi-tool-display` 或 `pi-tool-display-summary`，因为三者都可能持有同名内置工具。

测试 `pi-subagents` 时，不要同时加载 `@tintinweb/pi-subagents`（会双注册 `Agent` / FleetView）。

测试 `pi-meter` 时，不要同时加载 `@pi-plugins/usage`（会双注册 `/usage`）。

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
