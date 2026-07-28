# pi-search-hub

[简体中文](./README.zh-CN.md)

A bundle-private fork of Search Hub for `@zhcsyncer/pi-extensions`. It provides unified `web_search` and `web_read` tools across multiple search and content-reading backends.

This package is private and is not published separately. Install `@zhcsyncer/pi-extensions` to use it.

## Tools

### `web_search`

Searches the web through an explicitly selected backend or through automatic routing. Fallback mode tries enabled backends in order and stops at the first success. `combine=true` queries multiple enabled backends and merges/deduplicates their results: `combineMode: "targeted"` collects up to three usable backend result sets, while `combineMode: "all"` queries every enabled backend. Combine is ignored when a call explicitly selects one backend.

Important call options include:

- `query` — natural-language search query;
- `numResults` — requested result count from 1 to 20;
- `backend` — a specific backend or `auto`;
- `combine` — enable multi-backend search;
- `compact` — return title-and-URL lines instead of verbose search content.

DuckDuckGo is the keyless fallback when no backend is explicitly enabled. Other supported backends include Jina Search, Marginalia, Serper, Tavily, Exa, Exa MCP, OpenAI Codex, Brave, Brave LLM Context, LangSearch, Firecrawl, WebSearchAPI, Perplexity, SearXNG, Linkup, You.com, fastCRW, and Sofya.

### `web_read`

Fetches a URL and returns extracted Markdown. The configured `reader` is the default reader and is independent of the default search backend. When a call omits `reader`, Search Hub tries the default followed by `readerFallback` in order; an explicit `reader` uses only that reader. Readers fail over sequentially and are never queried or merged in parallel. The default Jina reader supports remote cache bypass, keywords, `rush`/`smart` modes, and targeted extraction. Sofya, Firecrawl, Exa, and Exa MCP readers are also available.

Important call options include:

- `url` — page URL;
- `fresh` — bypass reader caches where supported;
- `keywords` — terms used to focus long-page extraction;
- `mode` — `rush` for speed or `smart` for better narrowing;
- `reader` — use only the specified reader, bypassing configured reader fallback;
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

Search and read progress is emitted through the active tool call rather than a persistent footer status. Semantic result status includes:

| Tool | Status |
|---|---|
| `web_search` | Actual backend, result count, fallback state, and usable/attempted backend health for combined searches |
| `web_read` | Actual reader, extracted character count, and whether display content was truncated to the 10k-character presentation limit |

Verbose search output begins with a raw `## Search Results:` header. The shared renderer skips that duplicated header when its semantic status is already visible.

Global `results.mode` controls whether Search Hub results are hidden, summarized, or previewed in the transcript. Content previews use the same wrapped-row `results.previewRows` budget as other decorated tools. Search Hub still owns the content sent to the model, including backend selection, result quantity, compact result generation, and backend-level truncation. In particular, the `web_search.compact` argument changes the tool result itself and is independent of the TUI-only global result mode.

## Configuration

Search Hub reads configuration from:

1. `$PI_CODING_AGENT_DIR/extension-data/pi-search-hub/config.json` for global settings;
2. `.pi/extension-data/pi-search-hub/config.json` in a trusted current project.

Trusted project settings win. Backend maps are merged per backend, so a project can override one backend without repeating every global entry. Untrusted projects are never probed for Search Hub configuration. Configuration is refreshed during use; interactive edits are staged until `Save & apply`.

On first use, Search Hub automatically migrates the previous global and trusted-project paths, upgrades recognized settings, drops unmappable fields with a warning, and removes the old file only after the new file passes a semantic round trip. Exa usage state similarly moves to `$PI_CODING_AGENT_DIR/extension-data/pi-search-hub/state/exa-usage.json` with serialized atomic updates.

### Interactive setup

Run `/search-setup` to view effective Search Hub status and edit the global configuration from one place. The top-level page summarizes search routing, web reading, backend and credential counts, and output, then opens dedicated `Search routing`, `Web reading`, `Backends`, and `Output` pages. The long backend list lives only on the Backends page; there is no separate `/search-status` command.

Each concise backend row starts with `[ON]`, `[OFF]`, or `[AUTO]` and uses one `auth` vocabulary across API keys and Pi credentials: `auth ✓ saved key`, `auth ✓ env <name>`, `auth ✓ Pi /login`, `auth ✗ missing`, `auth — optional`, or `auth — not required`. An unset reference is treated as no resolved credential. A shell-command credential is marked `auth ? shell command` because setup does not execute it merely to render status. Selecting a backend compares the global draft with the effective configuration after project overrides, and offers separate switch, credential, URL, and Pi-auth actions. Disabling retains credentials; re-enabling reuses a still-resolvable credential. The bulk action enables only ready keyless hosted backends, leaving SearXNG off until an instance URL is configured.

All pages edit one in-memory global draft. `Back` never writes, and the home page marks unsaved changes. `Save & apply` normalizes the draft, removes obsolete fields, writes the global file atomically with mode `0600`, refreshes runtime configuration once, and emits one result notification. Closing with pending edits offers `Save & apply`, `Discard changes`, or `Continue editing`. After a successful save, `/reload` or a new session is not required.

`/search-setup` changes only the global file. A trusted project `.pi/extension-data/pi-search-hub/config.json` can override that change for the current project; Search Hub reports this after saving. Disabling a backend does not delete a stored credential; use `Remove saved API key or reference` in that backend's detail menu when it must also be removed from disk. Search Hub does not cache search results locally; `web_read.fresh` only asks supported remote readers to bypass their own caches.

Minimal example:

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

Copy [`search.json.example`](./search.json.example) for a larger backend matrix. Search-service credentials (including Jina's optional key) may be environment-variable names such as `JINA_API_KEY`, shell commands prefixed with `!`, or key values saved directly in the configuration. Prefer environment variables or a secret manager, and never commit credentials. OpenAI Codex is the exception: it resolves the existing `openai-codex` provider credential from the current Pi model registry, so `/login openai-codex` remains the single source of truth. Other search services are not Pi model providers, and Pi currently exposes no generic extension secret store, so Search Hub does not register fake providers merely to place their keys in `auth.json`.

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
