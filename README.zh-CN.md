# pi-extensions

[English](./README.md)

zhcsyncer 维护的一组 Pi extensions。

## 包列表

- [`@zhcsyncer/pi-recap`](./packages/pi-recap) — 最近活动回顾扩展，可选同步 Session 标题和 tmux 窗口名。
- [`@zhcsyncer/pi-tool-display-intent`](./packages/pi-tool-display-intent) — 紧凑工具展示，支持模型生成的 intent、RPC 可见摘要、自适应 diff 和受限的 Bash 调用预览。
- [`@zhcsyncer/pi-todo`](./packages/pi-todo) — `@juicesharp/rpiv-todo` 的维护 fork，提供持久 Todo overlay，且不会重复展示成功的工具节点。
- [`@zhcsyncer/pi-search-hub`](./packages/pi-search-hub) — bundle 私有的 `web_search` 和 `web_read` 工具，集成 intent-aware 展示。

## Bundle 私有 Search Hub

聚合包 `@zhcsyncer/pi-extensions` 内置私有 Search Hub fork，并注册其 `web_search` 和 `web_read` 工具。Search Hub 不作为独立 npm 包发布；需要安装根 bundle 才能使用。

该 fork 保留上游多后端搜索和页面提取能力，同时集成模型生成的 `displaySummary` intent、语义化 query/URL 调用行、backend 和 reader 状态，以及共享的工具结果展示模式。配置与本地行为详见 [Search Hub 中文文档](./packages/pi-search-hub/README.zh-CN.md) 或其 [英文版本](./packages/pi-search-hub/README.md)。

## 从 Git 安装

从本仓库安装完整 extension bundle：

```bash
pi install git:github.com/zhcsyncer/pi-extensions@v0.4.0
```

不安装直接试用：

```bash
pi -e git:github.com/zhcsyncer/pi-extensions
```

## 从 npm 安装

安装包含私有 Search Hub fork 的完整 bundle：

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
pi --no-extensions -e ./packages/pi-search-hub --list-models nope
```

测试 `pi-tool-display-intent` 时，不要同时加载原始 `pi-tool-display` 或 `pi-tool-display-summary`，因为三者都可能持有同名内置工具。

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

`pi-search-hub` fork 自 [`ronnieops/pi-search-hub`](https://github.com/ronnieops/pi-search-hub) 2.8.0，其 package metadata 和 README 声明为 MIT。准确 revision 和保留声明见 [`packages/pi-search-hub/UPSTREAM_SOURCE.md`](./packages/pi-search-hub/UPSTREAM_SOURCE.md) 与 [`UPSTREAM_NOTICE.md`](./packages/pi-search-hub/UPSTREAM_NOTICE.md)。
