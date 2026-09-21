# Search Hub 供应商收缩

状态：契约已拍板，未开工。实现走独立 session，从最新 `origin/main` 开 `feat-search-hub-slim-backends`；可用 git worktree 隔离。禁止在主仓当前工作区直接改实现。

## Why

Search Hub 现在挂了约 19 个 search backend 和 5 个 reader。对编码代理来说多数用不上，配置面和 `/search-setup` 也被长名单拖垮。本地 effectiveness 与社区用法都指向同一组：Exa、Firecrawl、Tavily、Parallel。

本轮只做供应商收缩和契约收口。不重做 TUI。

## 已拍板

| 项 | 决定 |
|---|---|
| 保留 search | `exa`、`tavily`、`firecrawl`、`parallel` |
| 默认 search | `exa` |
| 无人启用时的 keyless fallback | `firecrawl`（替代现在的 `duckduckgo`） |
| 保留 reader | `firecrawl`、`exa`、`parallel` |
| 默认 reader | `firecrawl` |
| 默认 `readerFallback` | `["exa", "parallel"]` |
| `selectionStrategy` | 保留，四种值不变 |
| combine / combineMode / compact | 保留；`compact` 改送给模型的 tool result |
| Parallel | 只接官方 REST + API key；不接免注册 MCP |
| 多 key | `apiKeys: string[]`；旧 `apiKey` 存盘时归一进数组 |
| 轮换时机 | 仅 429 / 402 / 432 / 配额用完才试下一把；普通 4xx/5xx/超时不换 |
| key 游标 | 按 backend 记在 `extension-data/pi-search-hub/state/key-cursors.json`；key 列表变了重置 |
| 显式 `backend=` | 指定一家就只打这一家，不 fallback、不 combine、不看 `selectionStrategy` |
| `web_read` 参数 | 只留 `url` + `reader`；删掉 Jina 专属的 `fresh` / `keywords` / `mode` / CSS `objective` |

删除：`duckduckgo`、`jina`、`sofya`、`marginalia`、`serper`、`exa_mcp`、`openai-codex`、`brave`、`brave-llm`、`langsearch`、`websearchapi`、`perplexity`、`searxng`、`linkup`、`youcom`、`fastcrw`。

`BackendConfig` 只留通用字段：`enabled`、`apiKey`（迁移用）、`apiKeys`、`timeout`、`maxResults`、`headers`。SearXNG / DDG / Perplexity / Brave LLM / Linkup / fastCRW / Sofya 的专用字段随供应商一起删。

## 红线

- 主仓当前工作区不改实现。独立 session 从 `origin/main` 开工。
- 废弃供应商是从代码删掉，不是只在配置里关掉。
- Parallel 没有无 key 路径。缺 key 就报 `MISSING_KEY_HELP`，不静默降级。
- Firecrawl 继续允许无 key；Exa、Tavily、Parallel 必须有 key。
- `selectionStrategy` 只排序 fallback / targeted combine 的尝试顺序。`combineMode: "all"` 仍打全部已启用 backend。调用方写了具体 `backend=` 时 combine 和 strategy 都不介入。
- `compact=true` 时模型只拿到 title + URL；snippet / content 不进上下文。TUI `results.mode` 管展示，不管这段。
- 旧配置里的废弃 backend / reader / 专用字段：normalize 时丢弃并 warning，不阻塞加载。
- 磁盘上已有的 key 不因 disable 被删。
- 不提交、不推送、不合并，除非用户之后明确要求。

## 现有机制（收契约时不要改语义）

`selectionStrategy` 入口在 `extensions/dispatch.ts` 的 `selectBackendsForFallback`。`web_search` 在 fallback 和 `combineMode: "targeted"` 前调用它，给已启用列表重新排序：

- `sequential`：保持 `getActiveBackends()` 顺序（`defaultBackend` 已置顶）
- `random`：洗牌
- `round-robin`：轮转置顶
- `best-latency`：按 scoring 排序

`getActiveBackends()` 今天在无人启用时硬塞 `duckduckgo`。收口后改成硬塞 `firecrawl`。显式 `backend=` 本来就会绕开整个 active 列表，这不是新逻辑。

Reader 仍然顺序 failover，永不并行、不合并。调用方写了 `reader=` 时只用那一家。

## 契约层要落到的形状

`extensions/types.ts`：

```ts
export const SEARCH_BACKEND_NAMES = ["exa", "tavily", "firecrawl", "parallel"] as const;
export const READER_NAMES = ["firecrawl", "exa", "parallel"] as const;
export const DEFAULT_SEARCH_BACKEND = "exa";
export const DEFAULT_READER = "firecrawl";
export const DEFAULT_READER_FALLBACK = ["exa", "parallel"] as const;
```

`SearchConfig.backends` 只声明这四家。`FALLBACK_ENV_MAP` 只留：

- `exa` → `SEARCH_EXA_API_KEY`
- `tavily` → `SEARCH_TAVILY_API_KEY`
- `firecrawl` → `SEARCH_FIRECRAWL_API_KEY`
- `parallel` → `SEARCH_PARALLEL_API_KEY`

凭证解析顺序：`apiKeys`（或旧 `apiKey`）→ 上述 env。`withRotatedKeys` 只在 `isKeyRotationError` 为真时换下一把，并推进持久化游标。

`config-storage.ts` 用 `isSearchBackendName` / `isReaderName` 校验；不认识的 backend 整棵丢掉。存盘把 `apiKey` 迁进 `apiKeys`。

## Parallel HTTP

只走带 `x-api-key` 的官方 REST，不接 `search.parallel.ai/mcp`。

- Search：`POST https://api.parallel.ai/v1/search`，body `{ objective, search_queries, mode: "fast" }`。`objective` 用调用 query；`search_queries` 至少一条同 query。结果 `title` / `url` / `excerpts[]` 收成 snippet。
- Extract / `web_read`：`POST https://api.parallel.ai/v1/extract`，body `{ urls: [url], full_content: true }`。优先 `full_content`，没有则拼 `excerpts`。

本轮不把 Parallel extract 的自然语言 `objective` 暴露成 `web_read` 参数。

## 实施顺序

1. **独立工作区**  
   fetch `origin/main`，开 `feat-search-hub-slim-backends`。把本计划文件带进该分支。主仓当前工作区不再改实现。

2. **契约层**  
   `types.ts`、`credentials.ts`、`config.ts`、`config-storage.ts`、`paths.ts`、`utils.ts` 的 `MISSING_KEY_HELP`。先让配置加载、normalize、active 列表、多 key 解析和游标在新名单上自洽。此步不删 backend 文件。

3. **Parallel + 工具面**  
   新增 `backends/parallel.ts`。`registry.ts` 只注册四家。`search-hub.ts` 的 tool enum、reader 列表、默认 reader 顺序、`/search-setup` 选项与新契约对齐。`display.ts` 去掉 Jina 专属 metadata。

4. **删除与收口**  
   删废弃 backend / reader 实现和只为它们存在的测试。若 `wreq-js` 再无引用，从 `packages/pi-search-hub/package.json` 去掉。改包内双语 README、`search.json.example`；根 README 若点名旧供应商一并改。补 changeset（breaking：旧 backend 名不再合法）。`pnpm --filter @zhcsyncer/pi-search-hub check` 必须绿。

## 本轮明确不做

- `/search-setup` 改成 `SettingsList` 或扁平设置页。名单短了之后现有菜单能用；TUI 另开一轮。
- 把已删供应商藏成“禁用但仍在代码里”。
- Parallel 免费 MCP、第三方镜像、无 key 试用端点。
- 改 `combine` / RRF / effectiveness 记分公式。
- 在主仓当前工作区提前改代码。
- 提交、推送、发版。

## 主要会碰到的文件

契约：`extensions/types.ts`、`credentials.ts`、`config.ts`、`config-storage.ts`、`paths.ts`、`utils.ts`

工具面：`extensions/search-hub.ts`、`extensions/backends/registry.ts`、`extensions/backends/parallel.ts`（新）、`extensions/display.ts`

删除：`extensions/backends/` 下除 `exa.ts`、`tavily.ts`、`firecrawl.ts`、`parallel.ts`、`registry.ts` 以外的实现和对应测试

文档与示例：`packages/pi-search-hub/README.md`、`README.zh-CN.md`、`search.json.example`；根 `README.md` / `README.zh-CN.md` 若点名旧供应商一并改；本计划与 `docs/README.md` 索引

测试：`tests/setup.test.ts`、`storage-migration.test.ts`、`integration.test.ts`、`diagnostics.test.ts`、`firecrawl.test.ts`、`display.test.ts`；删掉只覆盖废弃 backend 的用例（`duckduckgo.test.ts`、`openai-codex.test.ts`、`exa-mcp-fetch.test.ts` 等）

## 验收

- 未启用任何 backend 时，active 列表是 `["firecrawl"]`。
- 启用了 `exa` 时，auto fallback 以 `exa` 开头；`selectionStrategy` 仍能重排。
- `web_search({ backend: "exa" })` 只打 Exa，不带 Firecrawl / Parallel。
- `web_read` 未指定 reader 时顺序是 firecrawl → exa → parallel。
- Parallel search / extract 无 key 直接失败，不走 MCP。
- 同一 backend 配多把 key 时，普通错误不轮换；429 / 402 / 432 / quota 才试下一把，且下次请求从推进后的游标开始。
- 旧 config 里的 `duckduckgo` / `jina` / `exa_mcp` 等被丢掉并有 migration notice，进程能起来。
- `web_read` schema 不再出现 `fresh` / `keywords` / `mode` / `objective`。
- 包 check 与相关测试绿；changeset 说明这是 breaking：旧 backend 名不再合法。
