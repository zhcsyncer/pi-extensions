# pi-tool-display-intent

[简体中文](./README.zh-CN.md)

![Collapsed Tools ledger](./assets/demo-aggregate-1.png)

`pi-tool-display-intent` is a modified fork of [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display) 0.5.0. It keeps compact tool rendering and adds model-written, user-facing intent. The `displaySummary` field is adapted from [`mertdeveci5/pi-tool-display-summary`](https://github.com/mertdeveci5/pi-tool-display-summary) 0.1.0.

```text
read docs/tax-code.pdf — Checking the Colorado tax code
$ pnpm test — Verifying the extension test suite

● Read(docs/tax-code.pdf) — Checking the Colorado tax code
  ⎿ loaded 42 lines
```

The current model writes `displaySummary` in the normal tool call. This extension does **not** make another inference request, use a second model, or need another API key.

## Features

- Bash always asks the current model for a `displaySummary` intent. Other built-ins keep deterministic targets only.
- Claude-style rows: status mark, `Name(target)`, and indented results.
- Optional `aggregate` layout: one Tools ledger per user request. `Agent` keeps its own renderer by default.
- Same compact / summary / preview result modes as upstream.
- Cooperative API so other tools can still opt into the same intent field.

Do not load `pi-tool-display`, `pi-tool-display-summary`, and this extension together. They register the same built-in tool names.

## Install

```bash
pi install npm:@zhcsyncer/pi-tool-display-intent
pi install npm:@zhcsyncer/pi-extensions
```

Then restart Pi or run `/reload`.

## Use

```text
/tools
/tools aggregate
/tools individual
```

Empty `/tools` opens the settings panel. Switching layout asks to reload this session, then saves and reloads. Remaining knobs stay in the panel.

## Layouts

`individual` is the default: each tool keeps its own row.

`aggregate` folds every registered built-in, custom, MCP, and late-loaded tool in one user request into one Tools view:

![Collapsed Tools ledger](./assets/demo-aggregate-1.png)

![Expanded Tools timeline](./assets/demo-aggregate-2.png)

![Failed Tools ledger](./assets/demo-aggregate-3.png)

```text
◐ Tools (16 calls · 3 turns) · read ×12 · ask_user_question ×1 · edit ×8 · bash ×16
  › 先对照两边入口
  ◐ Bash — 把策略固化成 zone · 54 lines · 2.3KB           12s

✓ Tools (17 calls · 3 turns) · read ×12 · ask_user_question ×1 · edit ×8 · bash ×17
  ↳ 2 steers
  took 2m14s · tok ↑62k ↓8.4k R120k W4.1k · at 2026-04-08 14:32:14
```

While a turn is running, the latest assistant note stays under the header as Markdown, up to three lines. Each visible call row right-aligns that call's elapsed time. After it settles, notes hide and a muted receipt shows duration, tokens, cache, and local time. Collapsed failures are `N failed` only. Mid-turn steers stay on the same Tools ledger: first lines pin under the header while it runs, then one `↳ N steers` line remains. `Ctrl+O` expands the original timeline, with each `↳` in place. The default `flat` timeline still shows one timed row per call; set `toolCalls.expandedTimeline` to `turns` to group those rows under `↻ 1/3 · 3 calls` headers with indented calls. Long bash scripts show intent and size instead of the body. `Agent` keeps its original renderer. Image reads stay in the Tools ledger like other output. Switch back with `/tools individual`.

User prompts always use the accent-gutter box.

## Settings

Open `/tools` or edit the example at [`config/config.example.json`](./config/config.example.json).

| What you change | Effect |
|---|---|
| `toolCalls.layout` | `individual` or `aggregate` |
| `toolCalls.expandedTimeline` | `flat` per-call Ctrl+O rows, or `turns` grouped by agent turn (aggregate only; no reload) |
| `results.mode` | `compact`, `summary`, or `preview` |
| `intent.language` | Language for model-written intent |
| `diff.collapsedMode` | `body` preview, or `summary` stats only |
| `tools.passthrough` | Tools that keep their original renderer in aggregate |

Older `toolCalls.style` and `transcript.userMessageStyle` settings are ignored.

## Custom tools

Wrap the tool **before** `pi.registerTool` if you want the same intent field:

```ts
import {
  decorateToolForDisplay,
  withDisplaySummary,
} from "@zhcsyncer/pi-tool-display-intent/tool-display-api-consumer";
import { Type } from "typebox";

const tool = withDisplaySummary({
  name: "web_search",
  label: "Web Search",
  description: "Search the web.",
  parameters: Type.Object({
    query: Type.String()
  }),
  async execute(_toolCallId: string, args: { query: string }) {
    return runSearch(args.query);
  }
}, {
  language: "auto",
  required: true
});

pi.registerTool(decorateToolForDisplay(tool, {
  kind: "generic",
  outputMode: "inherit",
  overrideExistingRenderers: true
}));
```

## License

MIT. See [`LICENSE`](./LICENSE) and [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE).
