# pi-search-hub

[English](./README.md)

`@zhcsyncer/pi-extensions` 使用的 bundle 私有 Search Hub fork。它通过多个搜索和内容读取 backend 提供统一的 `web_search` 与 `web_read` 工具。

该 package 是私有包，不会单独发布。安装 `@zhcsyncer/pi-extensions` 后即可使用。

## 工具

### `web_search`

通过明确指定的 backend 搜索，或使用自动 fallback。`combine=true` 会并行查询多个已启用 backend，并合并、去重结果；在 `search.json` 中设置 `combineMode: "targeted"` 可以限制 fan-out，同时仍收集多个可用结果集。

主要调用参数：

- `query` — 自然语言搜索词；
- `numResults` — 1 到 20 的目标结果数；
- `backend` — 指定 backend 或 `auto`；
- `combine` — 启用多 backend 搜索；
- `compact` — 返回标题与 URL 单行，而不是详细搜索正文。

没有明确启用 backend 时，DuckDuckGo 是无需 key 的 fallback。其他受支持 backend 包括 Jina Search、Marginalia、Serper、Tavily、Exa、Exa MCP、OpenAI Codex、Brave、Brave LLM Context、LangSearch、Firecrawl、WebSearchAPI、Perplexity、SearXNG、Linkup、You.com、fastCRW 和 Sofya。

### `web_read`

读取 URL 并返回提取后的 Markdown。默认 Jina reader 支持绕过缓存、keywords、`rush`/`smart` 模式和定向提取，也可以使用 Sofya、Firecrawl、Exa 与 Exa MCP reader。

主要调用参数：

- `url` — 页面 URL；
- `fresh` — 在 reader 支持时绕过缓存；
- `keywords` — 聚焦长页面提取的关键词；
- `mode` — `rush` 优先速度，`smart` 提高筛选质量；
- `reader` — 覆盖配置的 reader；
- `objective` — Jina CSS target selector。

> `web_read.objective` 是通过 `x-target-selector` 传给 Jina 的 CSS selector，不是自然语言问题或提取指令。应使用 `main`、`article`、`#pricing` 等值；语义聚焦请使用 `keywords`。

## 本 fork 的 intent-aware 展示

两个工具都使用 [`pi-tool-display-intent`](../pi-tool-display-intent) 的合作式 API，而不是维护独立 TUI renderer：

- 当前模型在正常 tool call 中写入必填的 `displaySummary` intent，不会增加额外推理请求；
- 纯展示字段会在 Search Hub 执行前移除；
- 调用行显示搜索词或缩短后的 URL，而不是通用 `(N args)`；
- 结果通过 `outputMode: "inherit"` 继承当前全局 `results.mode`。

语义化调用元数据包括：

| 工具 | Target | 元数据 |
|---|---|---|
| `web_search` | 搜索词 | 请求的 backend、combine 模式、结果上限、compact 模式 |
| `web_read` | 缩短后的 URL | reader、rush/smart 模式、keyword 数量、fresh 模式、是否使用 selector |

语义化结果状态包括：

| 工具 | 状态 |
|---|---|
| `web_search` | 实际 backend、结果数、fallback 状态，以及组合搜索中可用/已尝试 backend 健康度 |
| `web_read` | 实际 reader、提取字符数，以及展示内容是否被截断到 1 万字符上限 |

详细搜索输出以原始 `## Search Results:` header 开头。共享 renderer 已显示语义状态时，会跳过这个重复 header。

全局 `results.mode` 控制 Search Hub 结果在 transcript 中隐藏、显示摘要还是显示预览。内容预览与其他装饰工具共用折行后的 `results.previewRows` 行预算。发送给模型的内容仍由 Search Hub 负责，包括 backend 选择、结果数量、compact 结果生成和 backend 级截断。特别是，`web_search.compact` 参数会改变工具结果本身，与仅影响 TUI 的全局结果模式相互独立。

## 配置

Search Hub 从以下位置读取配置：

1. `$PI_CODING_AGENT_DIR/extensions/search.json`：全局设置；
2. 当前项目的 `.pi/search.json`。

项目设置优先。backend map 会按单个 backend 合并，因此项目可以只覆盖一个 backend，无需重复全部全局条目。配置会在使用过程中刷新，并带有较短的进程内缓存。

最小示例：

```json
{
  "defaultBackend": "auto",
  "combineMode": "targeted",
  "reader": "jina",
  "backends": {
    "duckduckgo": { "enabled": true },
    "serper": { "enabled": true, "apiKey": "SERPER_API_KEY" }
  }
}
```

可以复制 [`search.json.example`](./search.json.example) 获取更完整的 backend 配置矩阵。Credential 可以是 `SERPER_API_KEY` 这样的环境变量名、以 `!` 开头的 shell command，或 literal key。优先使用环境变量或 secret manager，绝不要提交凭据。

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
