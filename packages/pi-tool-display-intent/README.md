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
- Fullscreen mouse support: click a collapsed Tools block to expand that run, click its expanded summary to collapse it, and inspect individual call results without rerunning tools.
- Optional context-growth receipts and per-turn badges to spot context-heavy steps.
- Bounded multiline call targets, indented failure details, and safe top-level argument previews for generic custom tools.
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

Empty `/tools` opens the settings panel. Switching layout asks to reload this session, then saves and reloads. Bash intent language is available in both layouts and applies after `/reload`; layout-specific display knobs stay in the panel.

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

While a turn is running, the latest assistant note stays under the header as Markdown, up to three lines. Each visible call keeps its elapsed time right-aligned on the first row and may use one bounded continuation row. After it settles, notes hide and a muted receipt shows duration, tokens, cache, and local time. Collapsed failures are `N failed` only. Mid-turn steers stay on the same Tools ledger: first lines pin under the header while it runs, then one `↳ N steers` line remains. `Ctrl+O` expands the original timeline, with each `↳` in place, up to eight rows per call; failure details use an indented continuation row. The default `flat` timeline still shows one timed entry per call; set `toolCalls.expandedTimeline` to `turns` to group those entries under `↻ 1/3 · 3 calls` headers with indented calls. Long bash scripts show intent and size instead of the body. `Agent` keeps its original renderer. Image reads stay in the Tools ledger like other output. Switch back with `/tools individual`.

User prompts always use the accent-gutter box.

### Click to inspect

In Pi **0.85+ fullscreen mode**, click anywhere in a **collapsed Tools block**, including the receipt and current-call previews, to expand only that run. When expanded, the whole title/summary area can collapse it again. Top/bottom padding and expanded narration text do not toggle the ledger; dragging still selects text. `Ctrl+O` still switches the whole transcript and overrides local choices. Passthrough tools keep their native interactions.

Click an expanded tool-call row to open a read-only **Result / Args** viewer. Result shows JSON with syntax colors, clear custom-tool Markdown as formatted content, and source/log output literally. Args uses key/value rows and multiline text blocks instead of escaped JSON strings. Extra **Metadata** lives behind `⋯` / `M`; it does not enter the primary Tab cycle. `Raw` / `R` switches formatted pages to source text or JSON without bypassing credential masking or safety limits. Long lines wrap automatically, including after resizing. Use `Tab` to switch Result/Args, arrows/Page Up/Page Down or the wheel to scroll, and `Esc` to return. Only actual masking or truncation adds a small notice. Credential masking protects Args and Metadata; original Result/steer text, including edited code, is not silently rewritten. Large content has explicit safety limits; output already truncated by the tool cannot be recovered.

For a successful Edit with returned diff data, **Result is the diff**: single-column colored changes with line numbers and automatic wrapping, without a separate Diff tab. Continuation rows do not repeat line numbers. Raw retains the original return text and diff source; failures or missing diff data show the ordinary result. Historical changes are never reconstructed from the current file.

Expanded steers wrap at the terminal width. Up to eight content rows stay visible; longer messages keep the first three and last two rows around `… N lines hidden · click to view`. Click that omission row to inspect the original message. Collapsed steers still occupy one line each.

### Context growth

In aggregate, open `/tools` and turn **Context growth** on (default: off). The run receipt shows net growth; choose **Expanded timeline → turns** to see which steps contributed:

```text
took 18s · ctx ≈+3.2k · tok ↑… ↓…
↻ 1/2 · 2 calls · ctx +2.4k
```

A subsequent completed request supplies the input difference, displayed on the **preceding** turn. The last/unconfirmed turn uses a local estimate marked `≈`; any estimate also marks the run total. Text-only and passthrough-only turns use a lightweight footer rather than an empty Tools frame. `flat` shows only the run total. Switching this setting does not reload.

`ctx` measures context growth, not cumulative token consumption (`tok`) or individual tool costs. Reported differences may also reflect prompt/provider transformations. Missing data or known context boundaries such as steering, compaction, or model changes make the run total `ctx n/a` instead of a misleading number.

## Settings

Open `/tools` or edit the example at [`config/config.example.json`](./config/config.example.json).

| What you change | Effect |
|---|---|
| `toolCalls.layout` | `individual` or `aggregate` |
| `toolCalls.expandedTimeline` | `flat` per-call Ctrl+O rows, or `turns` grouped by agent turn (aggregate only; no reload) |
| `toolCalls.showContextGrowth` | Show `ctx` run totals and turn badges; default `false` (aggregate only; no reload) |
| `results.mode` | `compact`, `summary`, or `preview` |
| `intent.language` | Bash intent language: best-effort request following, Simplified Chinese, or English (applies after `/reload`) |
| `diff.collapsedMode` | `body` preview, or `summary` stats only |
| `tools.passthrough` | Tools that keep their original renderer in aggregate |

Older `toolCalls.style` and `transcript.userMessageStyle` settings are ignored.

## Custom tools

Generic custom tools without a call-presentation adapter show a safe, bounded preview of their top-level arguments. The preview is capped at 120 characters; scalar values are shortened, arrays and objects show only their shape, and credential-like keys or values are redacted. A tool-provided `getCallPresentation` remains authoritative.

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
