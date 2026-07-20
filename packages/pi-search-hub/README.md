# pi-search-hub

[简体中文](./README.zh-CN.md)

A bundle-private fork of Search Hub for `@zhcsyncer/pi-extensions`. It provides unified `web_search` and `web_read` tools across multiple search and content-reading backends.

This package is private and is not published separately. Install `@zhcsyncer/pi-extensions` to use it.

## Tools

### `web_search`

Searches the web through an explicitly selected backend or through automatic fallback. `combine=true` queries multiple enabled backends and merges/deduplicates their results; `combineMode: "targeted"` in `search.json` limits fan-out while still collecting multiple usable result sets.

Important call options include:

- `query` — natural-language search query;
- `numResults` — requested result count from 1 to 20;
- `backend` — a specific backend or `auto`;
- `combine` — enable multi-backend search;
- `compact` — return title-and-URL lines instead of verbose search content.

DuckDuckGo is the keyless fallback when no backend is explicitly enabled. Other supported backends include Jina Search, Marginalia, Serper, Tavily, Exa, Exa MCP, OpenAI Codex, Brave, Brave LLM Context, LangSearch, Firecrawl, WebSearchAPI, Perplexity, SearXNG, Linkup, You.com, fastCRW, and Sofya.

### `web_read`

Fetches a URL and returns extracted Markdown. The default Jina reader supports cache bypass, keywords, `rush`/`smart` modes, and targeted extraction. Sofya, Firecrawl, Exa, and Exa MCP readers are also available.

Important call options include:

- `url` — page URL;
- `fresh` — bypass reader caches where supported;
- `keywords` — terms used to focus long-page extraction;
- `mode` — `rush` for speed or `smart` for better narrowing;
- `reader` — override the configured reader;
- `objective` — a Jina CSS target selector.

> `web_read.objective` is a CSS selector passed to Jina as `x-target-selector`. It is not a natural-language question or extraction instruction. Use values such as `main`, `article`, or `#pricing`, and use `keywords` for semantic focus.

## Intent-aware display in this fork

Both tools use the cooperative API from [`pi-tool-display-intent`](../pi-tool-display-intent) rather than maintaining separate TUI renderers:

- the current model writes a required `displaySummary` intent in the normal tool call, with no additional inference request;
- the presentation-only field is removed before Search Hub execution;
- call lines show the search query or a shortened URL instead of generic `(N args)` text;
- result rendering inherits the active global `results.mode` through `outputMode: "inherit"`.

Semantic call metadata includes:

| Tool | Target | Metadata |
|---|---|---|
| `web_search` | Search query | Requested backend, combine mode, result limit, compact mode |
| `web_read` | Shortened URL | Reader, rush/smart mode, keyword count, fresh mode, selector presence |

Semantic result status includes:

| Tool | Status |
|---|---|
| `web_search` | Actual backend, result count, fallback state, and usable/attempted backend health for combined searches |
| `web_read` | Actual reader, extracted character count, and whether display content was truncated to the 10k-character presentation limit |

Verbose search output begins with a raw `## Search Results:` header. The shared renderer skips that duplicated header when its semantic status is already visible.

Global `results.mode` controls whether Search Hub results are hidden, summarized, or previewed in the transcript. Content previews use the same wrapped-row `results.previewRows` budget as other decorated tools. Search Hub still owns the content sent to the model, including backend selection, result quantity, compact result generation, and backend-level truncation. In particular, the `web_search.compact` argument changes the tool result itself and is independent of the TUI-only global result mode.

## Configuration

Search Hub reads configuration from:

1. `$PI_CODING_AGENT_DIR/extensions/search.json` for global settings;
2. `.pi/search.json` in the current project.

Project settings win. Backend maps are merged per backend, so a project can override one backend without repeating every global entry. Configuration is refreshed during use, with a short in-process cache.

Minimal example:

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

Copy [`search.json.example`](./search.json.example) for a larger backend matrix. Credential values may be environment-variable names such as `SERPER_API_KEY`, shell commands prefixed with `!`, or literal keys. Prefer environment variables or a secret manager, and never commit credentials.

See [`UPSTREAM_README.md`](./UPSTREAM_README.md) for the upstream backend-specific reference. Local behavior described in this README takes precedence for the bundled fork.

## Upstream source

- Repository: [`ronnieops/pi-search-hub`](https://github.com/ronnieops/pi-search-hub)
- Baseline: `v2.8.0` / `96ccf692123d35a3cf4b615d597a80fe9e9f6229`
- Preserved documentation: [`UPSTREAM_README.md`](./UPSTREAM_README.md)
- Preserved release history: [`UPSTREAM_CHANGELOG.md`](./UPSTREAM_CHANGELOG.md)

The exact source provenance is recorded in [`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md).

## Development

```bash
pnpm --filter @zhcsyncer/pi-search-hub check
pi --no-extensions -e ./packages/pi-search-hub --list-models __pi_search_hub_check__
```

## License

The upstream `package.json` and README declare MIT, but the `v2.8.0` tag does not contain a standalone license file. See [`UPSTREAM_NOTICE.md`](./UPSTREAM_NOTICE.md) for the preserved notice and [`LICENSE`](./LICENSE) for this fork's combined terms.
