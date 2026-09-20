# pi-search-hub

[简体中文](./README.zh-CN.md)

A bundle-private fork of Search Hub for `@zhcsyncer/pi-extensions`. It provides unified `web_search` and `web_read` tools across multiple search and content-reading backends.

This package is private and is not published separately. Install `@zhcsyncer/pi-extensions` to use it.

## Tools

### `web_search`

Searches the web through configured routing. Enabled backends are tried in order and the first success stops the call. `combine=true` is model-only (default off) and merges up to three usable sources, with each result tagged by source. Configuration cannot force combine on every call.

Important call options include:

- `query` — natural-language search query;
- `numResults` — requested result count from 1 to 20;
- `combine` — merge several enabled providers for the same query (default false);
- `compact` — return title-source-URL lines instead of verbose search content.

Supported search backends are Exa, Tavily, Firecrawl, Parallel, OpenAI Codex, and Grok. Firecrawl is the keyless fallback when no backend is explicitly enabled. Exa, Tavily, and Parallel require an API key. Codex and Grok use Pi `/login` (hosted web search on the provider's inference API) and do not store keys in Search Hub config. If a hosted backend hits a subscription usage limit, it is skipped for 5 hours. Routing is `priority` (an ordered enabled list), `random`, or `best-latency`.

### `web_read`

Fetches a URL and returns extracted Markdown. Readers are tried in order: Firecrawl, then Exa, then Parallel. They fail over sequentially and are never queried or merged in parallel. Firecrawl is keyless; Exa and Parallel need a key.

Important call options include:

- `url` — page URL.

## Intent-aware display in this fork

Both tools use the cooperative API from [`pi-tool-display-intent`](../pi-tool-display-intent) rather than maintaining separate TUI renderers:

- call lines show the search query or a shortened URL instead of generic `(N args)` text;
- result rendering inherits the active global `results.mode` through `outputMode: "inherit"`.

Semantic call metadata includes:

| Tool | Target | Metadata |
|---|---|---|
| `web_search` | Search query | Combine, result limit, compact mode |
| `web_read` | Shortened URL | Starting reader |

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

Trusted project settings win. Backend maps are merged per backend, so a project can override one backend without repeating every global entry. Untrusted projects are never probed for Search Hub configuration. Configuration is refreshed during use; interactive edits stay in a draft until you press `s`.

Configuration, credential and Exa usage warnings appear as deduplicated Pi notifications instead of raw terminal output. Repeated search or read failures for the same backend also raise a warning. Those local outcomes are not used as remaining quota. Successful tool results also retain warnings in their details, including in headless runs. Ordinary provider failures continue through the existing tool-error and fallback paths.

On first use, Search Hub automatically migrates the previous global and trusted-project paths, upgrades recognized settings, drops unmappable fields with a warning, and removes the old file only after the new file passes a semantic round trip. Exa usage state similarly moves to `$PI_CODING_AGENT_DIR/extension-data/pi-search-hub/state/exa-usage.json` with serialized atomic updates.

### Interactive setup

Run `/search-setup` to edit global routing and compact output. Provider switches, keys, and Codex/Grok models are on a second page. When routing is `priority`, the enabled try order is a separate list: pick with Enter, move with up/down. There is no separate `/search-status` command.

Edits stay in a draft. `s` saves; Esc closes immediately when clean. A dirty Esc asks once whether to discard or keep editing, and does not offer save in that prompt. Keys are edited in `ui.editor`, one reference per line, and are written only on save. Disabling a backend keeps stored keys. A trusted project config can still override the global file; setup only hints at that and does not edit the project file.

Minimal example:

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

Copy [`search.json.example`](./search.json.example) for a complete backend matrix. Credentials may be environment-variable names such as `EXA_API_KEY`, shell commands prefixed with `!`, or key values saved directly in `apiKeys`. Prefer environment variables or a secret manager, and never commit credentials. A legacy `apiKey` string is migrated into `apiKeys` on save. Multiple keys rotate only after 429, 402, 432, or quota exhaustion.

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
