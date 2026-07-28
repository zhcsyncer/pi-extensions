# pi-search-hub

[English](./README.md)

`@zhcsyncer/pi-extensions` 使用的 bundle 私有 Search Hub fork。它通过多个搜索和内容读取 backend 提供统一的 `web_search` 与 `web_read` 工具。

该 package 是私有包，不会单独发布。安装 `@zhcsyncer/pi-extensions` 后即可使用。

## 工具

### `web_search`

通过明确指定的 backend 搜索，或使用自动路由。Fallback 模式会按顺序尝试已启用 backend，并在首个成功结果处停止。`combine=true` 会查询多个已启用 backend，并合并、去重结果：`combineMode: "targeted"` 最多收集三个可用 backend 的结果集，`combineMode: "all"` 则查询全部已启用 backend。调用明确指定单个 backend 时会忽略 combine。

主要调用参数：

- `query` — 自然语言搜索词；
- `numResults` — 1 到 20 的目标结果数；
- `backend` — 指定 backend 或 `auto`；
- `combine` — 启用多 backend 搜索；
- `compact` — 返回标题与 URL 单行，而不是详细搜索正文。

没有明确启用 backend 时，DuckDuckGo 是无需 key 的 fallback。其他受支持 backend 包括 Jina Search、Marginalia、Serper、Tavily、Exa、Exa MCP、OpenAI Codex、Brave、Brave LLM Context、LangSearch、Firecrawl、WebSearchAPI、Perplexity、SearXNG、Linkup、You.com、fastCRW 和 Sofya。

### `web_read`

读取 URL 并返回提取后的 Markdown。配置中的 `reader` 是 default reader，与默认搜索 backend 相互独立。调用未传 `reader` 时，Search Hub 会依次尝试 default reader 和 `readerFallback`；显式传入 `reader` 时只使用该 reader。Reader 只做顺序 fallback，不会并行查询或合并多份内容。默认 Jina reader 支持绕过远端缓存、keywords、`rush`/`smart` 模式和定向提取，也可以使用 Sofya、Firecrawl、Exa 与 Exa MCP reader。

主要调用参数：

- `url` — 页面 URL；
- `fresh` — 在 reader 支持时绕过缓存；
- `keywords` — 聚焦长页面提取的关键词；
- `mode` — `rush` 优先速度，`smart` 提高筛选质量；
- `reader` — 仅使用指定 reader，并跳过配置的 reader fallback；
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

搜索与读取进度通过当前 tool call 展示，不再写入常驻 footer 状态。语义化结果状态包括：

| 工具 | 状态 |
|---|---|
| `web_search` | 实际 backend、结果数、fallback 状态，以及组合搜索中可用/已尝试 backend 健康度 |
| `web_read` | 实际 reader、提取字符数，以及展示内容是否被截断到 1 万字符上限 |

详细搜索输出以原始 `## Search Results:` header 开头。共享 renderer 已显示语义状态时，会跳过这个重复 header。

全局 `results.mode` 控制 Search Hub 结果在 transcript 中隐藏、显示摘要还是显示预览。内容预览与其他装饰工具共用折行后的 `results.previewRows` 行预算。发送给模型的内容仍由 Search Hub 负责，包括 backend 选择、结果数量、compact 结果生成和 backend 级截断。特别是，`web_search.compact` 参数会改变工具结果本身，与仅影响 TUI 的全局结果模式相互独立。

## 配置

Search Hub 从以下位置读取配置：

1. `$PI_CODING_AGENT_DIR/extension-data/pi-search-hub/config.json`：全局设置；
2. 受信任当前项目的 `.pi/extension-data/pi-search-hub/config.json`。

受信任项目的设置优先。backend map 会按单个 backend 合并，因此项目可以只覆盖一个 backend，无需重复全部全局条目。未受信任项目中的 Search Hub 配置不会被探测或读取。配置会在使用过程中刷新；交互式修改会暂存在草稿中，直到选择 `Save & apply`。

首次使用时，Search Hub 会自动迁移旧的全局路径和受信任项目路径，升级可识别设置，丢弃无法映射的字段并发出 warning；只有新文件通过语义 round trip 后才删除旧文件。Exa 用量状态也会迁入 `$PI_CODING_AGENT_DIR/extension-data/pi-search-hub/state/exa-usage.json`，并使用串行化原子更新。

### 交互式配置

运行 `/search-setup` 可在同一入口查看 Search Hub 的有效状态并编辑全局配置。一级页面只汇总搜索路由、网页读取、backend/credential 数量和输出设置，再进入独立的 `Search routing`、`Web reading`、`Backends` 与 `Output` 页面。较长的 backend 列表只出现在 Backends 二级页；不再提供独立的 `/search-status` 命令。

每个简洁 backend 行都以前置 `[ON]`、`[OFF]` 或 `[AUTO]` 开头，并对 API key 与 Pi credential 统一使用 `auth` 口径：`auth ✓ saved key`、`auth ✓ env <名称>`、`auth ✓ Pi /login`、`auth ✗ missing`、`auth — optional` 或 `auth — not required`。无法解析的引用按“当前没有 credential”展示。Shell command credential 会标成 `auth ? shell command`，因为 setup 不会仅为渲染状态而执行它。选择 backend 后会对比全局草稿与经过项目覆盖后的有效配置，并分别提供开关、credential、URL 和 Pi auth 操作。禁用会保留 credential；只要保留的 credential 仍可解析，重新启用时无需再次输入。批量操作只启用可直接使用的 keyless hosted backend，SearXNG 会保持关闭直到配置实例 URL。

所有页面共同编辑一份内存中的全局草稿。`Back` 不会写盘，一级页面会标记未保存修改。`Save & apply` 会归一化草稿、清理废弃字段、以 `0600` 权限原子写入全局文件，只刷新一次运行时配置，并只发一条结果通知。带未保存修改关闭时，可选择 `Save & apply`、`Discard changes` 或 `Continue editing`。保存成功后无需 `/reload` 或新建会话。

`/search-setup` 只修改全局文件。受信任项目的 `.pi/extension-data/pi-search-hub/config.json` 可以覆盖这次修改，Search Hub 会在保存后提示。禁用 backend 不会删除已保存的 credential；如果还需要从磁盘移除，请在该 backend 的详情菜单选择 `Remove saved API key or reference`。Search Hub 不在本地缓存搜索结果；`web_read.fresh` 只要求支持它的远端 reader 绕过自身缓存。

最小示例：

```json
{
  "defaultBackend": "duckduckgo",
  "combine": false,
  "combineMode": "targeted",
  "reader": "jina",
  "readerFallback": ["firecrawl", "exa_mcp"],
  "backends": {
    "duckduckgo": { "enabled": true },
    "serper": { "enabled": true, "apiKey": "SERPER_API_KEY" }
  }
}
```

可以复制 [`search.json.example`](./search.json.example) 获取更完整的 backend 配置矩阵。搜索服务 credential（包括 Jina 的可选 key）可以是 `JINA_API_KEY` 这样的环境变量名、以 `!` 开头的 shell command，或直接保存在配置中的 key 值。优先使用环境变量或 secret manager，绝不要提交凭据。OpenAI Codex 是例外：它从当前 Pi model registry 解析已有的 `openai-codex` provider credential，因此 `/login openai-codex` 是唯一凭据来源。其他搜索服务不是 Pi model provider，而 Pi 目前没有公开通用的 extension secret store，所以 Search Hub 不会为了把 key 放进 `auth.json` 而注册伪 provider。

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
