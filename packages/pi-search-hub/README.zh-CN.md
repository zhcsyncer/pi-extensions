# pi-search-hub

[English](./README.md)

`@zhcsyncer/pi-extensions` 使用的 bundle 私有 Search Hub fork。它通过多个搜索和内容读取 backend 提供统一的 `web_search` 与 `web_read` 工具。

该 package 是私有包，不会单独发布。安装 `@zhcsyncer/pi-extensions` 后即可使用。

## 工具

### `web_search`

按配置的路由搜索网页。已启用 backend 会按顺序尝试，第一次成功即停止。`combine=true` 只由模型打开（默认关闭），最多合并三家有结果的来源，每条结果都带来源。配置不能把 combine 设成全局强制。

主要调用参数：

- `query` — 自然语言搜索词；
- `numResults` — 1 到 20 的目标结果数；
- `combine` — 用同一 query 合并多家已启用 provider（默认 false）；
- `compact` — 返回标题、来源与 URL 单行，而不是详细搜索正文。

受支持的搜索 backend 为 Exa、Tavily、Firecrawl、Parallel、OpenAI Codex 和 Grok。没有明确启用 backend 时，Firecrawl 是无需 key 的 fallback。Exa、Tavily 和 Parallel 需要 API key。Codex 和 Grok 走 Pi `/login`（在对应推理 API 上注入 hosted web search），不把 key 写进 Search Hub 配置。hosted backend 若订阅额度耗尽，会跳过 5 小时，避免每次搜索都重试。路由为 `priority`（已启用的有序名单）、`random` 或 `best-latency`。

### `web_read`

读取 URL 并返回提取后的 Markdown。Reader 固定按 Firecrawl → Exa → Parallel 顺序尝试，只做顺序 fallback，不会并行查询或合并。Firecrawl 无需 key；Exa 和 Parallel 需要 key。

主要调用参数：

- `url` — 页面 URL。

## 工具行

Search Hub 自己画 Claude 风格的工具行，不再使用 `pi-tool-display-intent`。

- 调用行是 `● Web Search("query")` 或 `● Read Web Page(url)`，而不是通用 `(N args)`；
- 结果行显示 backend、条数、fallback 或提取长度。

语义化调用元数据包括：

| 工具 | Target | 元数据 |
|---|---|---|
| `web_search` | 搜索词 | combine、结果上限、compact 模式 |
| `web_read` | 缩短后的 URL | 起始 reader |

搜索与读取进度通过当前 tool call 展示，不再写入常驻 footer 状态。语义化结果状态包括：

| 工具 | 状态 |
|---|---|
| `web_search` | 实际 backend、结果数、fallback 状态，以及组合搜索中可用/已尝试 backend 健康度 |
| `web_read` | 实际 reader、提取字符数，以及展示内容是否被截断到 1 万字符上限 |

详细搜索输出在给模型的结果里仍以 `## Search Results:` header 开头。发送给模型的内容仍由 Search Hub 负责，包括 backend 选择、结果数量、compact 结果生成和 backend 级截断。`web_search.compact` 会改变工具结果本身，不只是 TUI 行。

## 配置

Search Hub 从以下位置读取配置：

1. `$PI_CODING_AGENT_DIR/extension-data/pi-search-hub/config.json`：全局设置；
2. 受信任当前项目的 `.pi/extension-data/pi-search-hub/config.json`。

受信任项目的设置优先。backend map 会按单个 backend 合并，因此项目可以只覆盖一个 backend，无需重复全部全局条目。未受信任项目中的 Search Hub 配置不会被探测或读取。配置会在使用过程中刷新；交互式修改会留在草稿中，直到按 `s` 保存。

配置、凭据和 Exa 用量告警通过 Pi 原生通知去重展示，不再直接写终端。同一 backend 的搜索或读取连续失败时也会告警。这些本地调用结果不用于推算剩余配额。成功的工具结果也会在详情中保留告警，无 UI 运行同样保留。普通 provider 失败仍走原有工具错误与 fallback 路径。

首次使用时，Search Hub 会自动迁移旧的全局路径和受信任项目路径，升级可识别设置，丢弃无法映射的字段并发出 warning；只有新文件通过语义 round trip 后才删除旧文件。Exa 用量状态也会迁入 `$PI_CODING_AGENT_DIR/extension-data/pi-search-hub/state/exa-usage.json`，并使用串行化原子更新。

### 交互式配置

运行 `/search-hub setup` 可编辑全局路由和 compact 输出。`/search-hub status` 显示本地余量账（Tavily/Firecrawl 剩余、已禁用的 key 和解禁时间），打开时不打官方接口。按 `r` 或 `/search-hub status refresh` 刷新 Tavily/Firecrawl 用量。各家开关、key，以及 Codex/Grok 模型在二级 Providers 页。仅 `priority` 路由时，已启用尝试顺序在独立列表里改：Enter 选中，上下键移动。

修改留在草稿中。`s` 保存；干净时 Esc 直接关闭。有未保存修改时 Esc 只确认一次是丢弃还是继续编辑，确认框里没有保存。Key 用 `ui.editor` 编辑，一行一个引用，只有保存时才写盘。禁用 backend 会保留已存 key。受信任项目配置仍可覆盖全局文件；设置页只提示这一点，不编辑项目文件。

最小示例：

```json
{
  "routing": "priority",
  "priority": ["exa", "firecrawl"],
  "backends": {
    "exa": { "enabled": true, "apiKeys": ["EXA_API_KEY"] },
    "firecrawl": { "enabled": true }
  }
}
```

可以复制 [`search.json.example`](./search.json.example) 获取完整 backend 配置矩阵。credential 可以是 `EXA_API_KEY` 这样的环境变量名、以 `!` 开头的 shell command，或直接保存在 `apiKeys` 中的 key 值。优先使用环境变量或 secret manager，绝不要提交凭据。旧的 `apiKey` 字符串会在存盘时迁入 `apiKeys`。多把 key 只在 429、402、432 或配额用尽时轮换。

上游 backend 专属参考见 [`UPSTREAM_README.md`](./UPSTREAM_README.md)。对于 bundle fork，本 README 描述的本地行为优先。

## 上游来源

- 仓库：[`ronnieops/pi-search-hub`](https://github.com/ronnieops/pi-search-hub)
- 基线：`v2.8.0` / `96ccf692123d35a3cf4b615d597a80fe9e9f6229`
- 保留文档：[`UPSTREAM_README.md`](./UPSTREAM_README.md)
- 保留版本历史：[`UPSTREAM_CHANGELOG.md`](./UPSTREAM_CHANGELOG.md)

准确来源记录见 [`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md)。

## 开发

```bash
pnpm --filter @zhcsyncer/pi-search-hub check
pi --no-extensions -e ./packages/pi-search-hub --list-models __pi_search_hub_check__
```

## 许可证

上游 `package.json` 和 README 声明为 MIT，但 `v2.8.0` tag 不包含独立许可证文件。保留声明见 [`UPSTREAM_NOTICE.md`](./UPSTREAM_NOTICE.md)，本 fork 的合并许可条款见 [`LICENSE`](./LICENSE)。
