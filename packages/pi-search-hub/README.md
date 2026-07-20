# pi-search-hub

`@zhcsyncer/pi-extensions` 内置的 Search Hub 扩展 fork。它提供统一的 `web_search` 与 `web_read` 工具，并支持多个搜索与内容读取后端。

当前 fork 保持上游 `pi-search-hub` 2.8.0 的搜索行为，并通过 `pi-tool-display-intent` 的合作式消费 API 为两个工具增加模型意图字段、统一调用行和继承全局 `results.mode` 的结果展示。调用行会用搜索词或缩短后的 URL 代替通用参数计数，并展示 backend、结果上限、reader、读取模式等关键元数据；结果区会展示实际 backend/reader、结果数、字符数、组合后端可用率和截断状态，同时去掉与语义状态重复的原始搜索头部。搜索正文的数量与截断仍由 Search Hub 自己负责。

## 来源

- 上游：[`ronnieops/pi-search-hub`](https://github.com/ronnieops/pi-search-hub)
- 基线：`v2.8.0` / `96ccf692123d35a3cf4b615d597a80fe9e9f6229`
- 上游文档：[`UPSTREAM_README.md`](./UPSTREAM_README.md)
- 上游版本历史：[`UPSTREAM_CHANGELOG.md`](./UPSTREAM_CHANGELOG.md)

该包目前作为 workspace 私有包随根 bundle 使用，不单独发布。

## 开发

```bash
pnpm --filter @zhcsyncer/pi-search-hub check
pi --no-extensions -e ./packages/pi-search-hub --list-models __pi_search_hub_check__
```

## 许可证

上游 `package.json` 和 README 将项目声明为 MIT，但 `v2.8.0` 标签未包含独立许可证文件。来源说明见 [`UPSTREAM_NOTICE.md`](./UPSTREAM_NOTICE.md)。本 fork 的修改见 [`LICENSE`](./LICENSE)。
