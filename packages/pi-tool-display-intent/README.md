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

- Shows model intent next to paths, commands, patterns, and diffs for owned `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`.
- Optional Claude-style rows: status mark, `Name(target)`, and indented results.
- Optional `aggregate` layout: one Tools ledger per user request. `Agent` keeps its own renderer by default.
- Same compact / summary / preview result modes as upstream.
- Cooperative API so other tools can add the same intent field.

Do not load `pi-tool-display`, `pi-tool-display-summary`, and this extension together. They register the same built-in tool names.

## Install

```bash
pi install npm:@zhcsyncer/pi-tool-display-intent
pi install npm:@zhcsyncer/pi-extensions
```

Then restart Pi or run `/reload`.

## Use

```text
/tool-display-intent
/tool-display-intent show
/tool-display-intent reset
/tool-display-intent layout individual
/tool-display-intent layout aggregate
/tool-display-intent mode compact
/tool-display-intent mode summary
/tool-display-intent mode preview
```

Layout and ownership changes take effect after `/reload`.

## Layouts

`individual` is the default: each tool keeps its own row.

`aggregate` folds every registered built-in, custom, MCP, and late-loaded tool in one user request into one Tools view:

![Collapsed Tools ledger](./assets/demo-aggregate-1.png)

![Expanded Tools timeline](./assets/demo-aggregate-2.png)

![Failed Tools ledger](./assets/demo-aggregate-3.png)

```text
◐ Tools (16 calls · 3 turns) · read ×12 · ask_user_question ×1 · edit ×8 · bash ×16
  › 先对照两边入口
  ◐ Bash(pnpm test)

✓ Tools (17 calls · 3 turns) · read ×12 · ask_user_question ×1 · edit ×8 · bash ×17
  took 2m14s · tok ↑62k ↓8.4k R120k W4.1k · at 2026-04-08 14:32:14
```

While a turn is running, the latest assistant note stays under the header as Markdown, up to three lines. After it settles, notes hide and a muted receipt shows duration, tokens, cache, and local time. Collapsed failures are `N failed` only. `Ctrl+O` expands the original timeline without dumping file contents or diffs. Images and `Agent` keep their original renderers. Switch back with `/tool-display-intent layout individual` then `/reload`.

Aggregate always uses a compact accent-gutter user prompt.

## Settings

Open `/tool-display-intent` or edit the example at [`config/config.example.json`](./config/config.example.json).

| What you change | Effect |
|---|---|
| `toolCalls.layout` | `individual` or `aggregate` |
| `toolCalls.style` | Default or Claude-style rows |
| `results.mode` | `compact`, `summary`, or `preview` |
| `intent.language` | Language for model-written intent |
| `diff.collapsedMode` | `body` preview, or `summary` stats only |
| `tools.passthrough` | Tools that keep their original renderer in aggregate |

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
