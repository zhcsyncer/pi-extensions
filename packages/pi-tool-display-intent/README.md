# pi-tool-display-intent

[中文文档](./README.zh-CN.md)

`pi-tool-display-intent` is a Pi extension that combines compact tool rendering with model-written, user-facing intent phrases.

```text
read docs/tax-code.pdf — Checking the Colorado tax code
$ pnpm test — Verifying the extension test suite

● Read(docs/tax-code.pdf) — Checking the Colorado tax code
  ⎿ loaded 42 lines
```

The model writes `displaySummary` as part of the normal tool call. The extension does **not** make an additional inference request, use a second model, or require another API key.

## Features

- Adds `displaySummary` to the owned `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write` schemas.
- Uses one Pi-deduplicated system-prompt guideline while keeping field-specific intent guidance in each tool schema.
- Shows the intent beside deterministic metadata such as paths, commands, patterns, and diff information.
- Strips the presentation field before calling the original tool implementation.
- Keeps the raw field available to Pi RPC consumers and retains it in later model context so follow-up calls keep producing intent.
- Uses deterministic per-tool fallbacks while a current call is executing; restored calls without a stored summary remain target-only.
- Sanitizes terminal control sequences and bounds displayed intent length.
- Offers an optional Claude Code-inspired TUI style with status markers, `Name(target)` headers, unboxed rows, and indented `⎿` results.
- Offers an optional aggregate layout that summarizes every registered tool in one bounded Tools view per user request, with `Agent` renderer passthrough by default.
- Preserves the compact output modes, MCP rendering, pending diff previews, adaptive edit/write diffs, thinking labels, and native user prompt box inherited from `pi-tool-display`.
- Provides a cooperative API for custom tools.

## Installation

Install only this package:

```bash
pi install npm:@zhcsyncer/pi-tool-display-intent
```

Install the complete extension bundle:

```bash
pi install npm:@zhcsyncer/pi-extensions
```

Or install the bundle from Git:

```bash
pi install git:github.com/zhcsyncer/pi-extensions
```

Try the local package during development:

```bash
pi --no-extensions -e ./packages/pi-tool-display-intent
```

> Do not load `pi-tool-display`, `pi-tool-display-summary`, and this extension together. They register the same built-in tool names, so the last owner wins rather than combining renderers.

## Usage

Open the interactive settings modal:

```text
/tool-display-intent
```

Direct commands:

```text
/tool-display-intent show
/tool-display-intent reset
/tool-display-intent layout individual
/tool-display-intent layout aggregate
/tool-display-intent mode compact
/tool-display-intent mode summary
/tool-display-intent mode preview
```

Tool ownership, layout, intent-schema, and renderer-shell changes take effect after `/reload`. Legacy `preset minimal|balanced|detailed`, `opencode`, and `verbose` command names remain accepted as aliases.

## Configuration

The global config is stored at:

```text
$PI_CODING_AGENT_DIR/extension-data/pi-tool-display-intent/config.json
```

When `PI_CODING_AGENT_DIR` is unset, Pi's default agent directory is used. Debug output, when explicitly enabled, is written to `$PI_CODING_AGENT_DIR/extension-data/pi-tool-display-intent/state/debug.log`. Extension enablement is managed through Pi package settings rather than another config switch. The v2 file is grouped by responsibility and stores only non-default values:

```json
{
  "$schema": "https://raw.githubusercontent.com/zhcsyncer/pi-extensions/main/packages/pi-tool-display-intent/config/config.schema.json",
  "version": 2,
  "intent": {
    "language": "en"
  },
  "toolCalls": {
    "layout": "aggregate",
    "style": "claude",
    "bashCommandPreviewRows": 1
  },
  "results": {
    "mode": "summary",
    "previewRows": 10
  }
}
```

See [`config/config.example.json`](./config/config.example.json) for every configurable field and [`config/config.schema.json`](./config/config.schema.json) for strict validation and editor completion.

| Section | Configurable fields | Purpose |
|---|---|---|
| `intent` | `enabled`, `language`, `maxLength` | Model-written tool intent. |
| `toolCalls` | `layout`, `style`, `bashCommandPreviewRows` | Individual or aggregate calls, call framing, and the wrapped-row budget for collapsed Bash command arguments. |
| `results` | `mode`, `previewRows` | Result amount and one shared wrapped-row preview budget. |
| `diff` | `layout`, `indicators`, `splitMinWidth`, `collapsedRows`, `collapsedMode`, `wordWrap` | Edit/write diff presentation. `collapsedMode: summary` shows only the +N -M stats line before Ctrl+O for the densest transcript; `body` (default) keeps the `collapsedRows` preview. |
| `transcript` | `userMessageStyle`, `thinkingLabel` | User messages and reasoning labels. |
| `tools` | `passthrough`, `custom` | Renderer ownership and explicitly listed custom tools. |
| `advanced` | `expandedRows`, `truncationHints`, `rtkCompactionHints`, `debug` | Expansion safety and diagnostics. |

`results.mode` has one direct meaning:

| Mode | Read/search/MCP | Bash |
|---|---|---|
| `compact` | Hide result bodies | Show a short preview |
| `summary` | Show counts or summaries | Show a line-count summary |
| `preview` | Show content previews | Show a content preview |

Every content preview, including custom tools and bash live/error output, uses `results.previewRows`. Its supported range is `2`–`80`, and it counts terminal rows after wrapping, so a minified JSON object, base64 payload, or other long single line cannot bypass the limit. A stored v2 value of `1` is migrated to `2`; `advanced.expandedRows` separately caps expanded output.

### Tool call layouts

`toolCalls.layout` defaults to `individual`, which preserves the complete existing per-tool behavior. `aggregate` summarizes every registered built-in, custom, MCP, and late-loaded tool within one user request:

```text
◐ Tools (16 calls · 3 turns) · read ×12 · ask_user_question ×1 · edit ×8 · bash ×16
  ◐ Bash(pnpm test)
  › 先对照两边入口

✓ Tools (17 calls · 3 turns) · read ×12 · ask_user_question ×1 · edit ×8 · bash ×17
  took 2m14s · tok ↑62k ↓8.4k R120k W4.1k · at 2026-04-08 14:32:14
```

The latest non-passthrough, non-image tool row carries Tools; older aggregated members occupy zero rows. Counts include pending, running, successful, and failed calls and remain in first-seen tool order. Collapsed failures appear only as `N failed` in the header. Up to three running or recently completed operations appear in assistant source order. A success changes to `done`; a newer call replaces the oldest retained `done`, and the final success folds 1.5 seconds after Pi reports the agent settled.

Every tool receives the same aggregate treatment and a deterministic theme color. Aggregate deliberately does not infer or report file-change summaries: edits made through Bash, custom tools, or child Agent sessions cannot be measured completely from the parent transcript. Images fail open to their original renderer. `Agent` also keeps its rich progress/result renderer by default, but still contributes to the Tools count. Other passthrough names can be added through `tools.passthrough`.

While collapsed, aggregate stays one Tools ledger: failures appear only as `N failed`, and at most three running or recent-done rows stay visible. While the turn is still running, the latest assistant note is pinned under those tool rows and does not use a tool slot. After the turn settles, every assistant note hides and a muted receipt under the header shows wall-clock duration, main-chain `↑` / `↓` tokens plus cache `R` / `W`, and local completion time. The final assistant conclusion stays outside the ledger. `Ctrl+O` keeps the unframed Tools summary and opens a Bash-style result gutter beneath it: mid-turn notes return in place with a `›` mark, and each call shows one compact target/status line. The last row uses `└`; earlier rows keep `│`. Expanded rows still do not dump output, file contents, or diff bodies. When Pi hides reasoning blocks, collapsed `Thinking...` placeholders are stripped; errors and explicitly revealed reasoning remain visible.

Aggregation changes only interactive rendering. It does not rewrite or append Session calls/results, and its projection is rebuilt from the current branch after reload, resume, tree navigation, or compaction. A custom tool's execution-time UI still runs; its transcript result is folded in aggregate. Switching to `individual` and reloading restores the original renderer and stored result—for example, completed `ask_user_question` answers become visible again.

Individual-only preferences remain in `config.json` while aggregate is active. The settings TUI hides them, and `/tool-display-intent show` marks them inactive. Layout changes take effect after `/reload` and redraw the whole current branch, not only future calls. To inspect historical raw details, switch back and reload:

```text
/tool-display-intent layout individual
/reload
```

Owned built-ins created while aggregate was active have no generated `displaySummary`; individual history uses deterministic targets and the original stored results.

`toolCalls.bashCommandPreviewRows` is a separate `1`–`8` wrapped-row budget for Bash command arguments and defaults to `1`. Short commands stay inline. Long or multiline commands collapse with exact line/size metadata; Claude-style calls keep intent in the header, put the command preview on its own row, and emphasize that row's shell prompt with the accent color. `Ctrl+O` reveals the complete original command and applies Bash syntax highlighting within safety limits. This setting does not affect command output. Claude-style Bash results use a connected left gutter through their final row in both collapsed and expanded views.

Path-bearing `read`, `grep`, `find`, `ls`, `edit`, and `write` calls keep short paths unchanged. When a full call header would wrap, the collapsed view removes middle path segments while preserving useful leading directories and the basename. `Ctrl+O` restores every path segment and lets the full header wrap normally; home paths remain normalized with `~`.

Model-written intent uses the theme's regular `accent` color without bold or background styling. Deterministic commands, paths, and queries use normal `text`; metadata, separators, and deterministic fallback intents remain `muted`.

`tools.passthrough` accepts any registered tool name whose original renderer should remain visible in aggregate; it does not disable the tool, and the call still contributes to Tools counts. `Agent` is included by default and omitted by sparse serialization. A built-in passthrough name also opts out of this extension's individual renderer override. A `tools.custom` entry configures the renderer used in individual mode, for example: `"web_search": { "renderer": "generic", "mode": "summary" }`. The bundle-private Search Hub already uses the cooperative API, so it needs no such entry unless you want to pin a mode instead of inheriting `results.mode`.

### Automatic legacy migration

On first load, the extension automatically moves the previous config path, legacy backup, and debug log into `extension-data`. An old flat config or pre-v2 version is normalized and atomically replaced after a validated v2 round trip. The first schema migration keeps `config.legacy.json` as a backup. Key mappings are:

- `displaySummary` / `toolIntent` → `intent`;
- `toolCallStyle` → `toolCalls.style`;
- legacy per-tool output modes → one `results.mode`;
- `previewLines` → `results.previewRows`;
- `registerToolOverrides` → `tools.passthrough`;
- `customToolOverrides` → `tools.custom` without an `enabled` switch;
- diff, transcript, hints, and debug → their corresponding sections.

`bashCollapsedLines` is intentionally discarded because all previews now share `results.previewRows`. Deprecated `displaySummary.required`, `displaySummary.showInTui`, unknown fields, and invalid values that cannot be mapped are also discarded. The Pi status bar reports the exact affected field paths. Malformed JSON and unsupported future schema versions are preserved and use defaults instead. Run `/reload` after editing the file directly.

When `intent.enabled` is on in the `individual` layout, `displaySummary` is required in owned built-in schemas and always shown in TUI. If a current executing call omits it, the renderer shows a deterministic fallback and `prepareArguments` backfills the raw arguments. Restored calls with no stored summary remain target-only, so aggregate history does not acquire invented intent after switching layouts. Since Pi emits the initial `tool_execution_start` before preparation, RPC clients should still provide their own fallback for that first event.

## Custom tools

Adding a model-facing field to another extension's tool requires cooperation from the tool provider. Wrap the complete definition **before** calling `pi.registerTool`:

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
    // args.displaySummary has already been removed here.
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

`withDisplaySummary`:

- keeps its API-level `required` option for custom tool providers, independently of the built-in `intent` config;
- rejects a tool that already defines a field named `displaySummary`, rather than changing that field's semantics;
- preserves and delegates the original `prepareArguments` and `execute` functions;
- strips the field before both delegation points where appropriate;
- is idempotent.

`decorateToolForDisplay` adds shared call rendering. For `generic` tools, setting `outputMode` also adds shared result rendering: `inherit` follows the active global `results.mode`, while `hidden`, `summary`, and `preview` pin the tool to one result mode. Omitting `outputMode` leaves the tool's existing result renderer untouched. Providers can also return a primary target plus metadata from `getCallPresentation` to replace generic `(N args)` text, and return semantic status plus `previewStartLine` from `getResultPresentation` to show backend/count summaries while skipping duplicated raw headers inside the shared visual-row budget. Presentation text is sanitized to one line, and callback failures fall back to generic rendering.

For shared generic and MCP rendering, failed results always show one error-colored summary derived from the first meaningful `content` line, even when the active mode is `hidden`; `Ctrl+O` shows the complete error content within the normal expanded-row budget. Empty error content falls back to `Tool failed.` Successful `hidden` results remain hidden, and semantic result presentations never replace the content-derived failure reason.

Pi 0.80.x exposes metadata, not complete arbitrary tool definitions, through `getAllTools()`. Therefore configuration-only discovery should not be treated as a reliable way to add intent schemas to unrelated extensions. Use the cooperative wrapper for schema and execution guarantees. `tools.custom` remains useful for presentation-only decoration where the definition is available.

## RPC and model context

The raw call remains suitable for RPC UI progress:

```json
{
  "path": "docs/tax-code.pdf",
  "displaySummary": "Checking the Colorado tax code"
}
```

In the individual layout, the extension retains `displaySummary` in later model context. This small token cost gives the model valid recent examples and prevents resumed or multi-turn runs from teaching the model to omit the required field. Persisted Session and RPC history keep the same argument as well. Aggregate does not register or generate this field.

## Security and cost

- There is no extra inference request; intent text uses a small number of tokens in the existing model response.
- Intent text is untrusted model output. ANSI/OSC/control sequences, newlines, and excess length are sanitized before TUI display.
- The extension keeps deterministic paths/commands/patterns visible, with complete compacted paths available through `Ctrl+O`; intent text must not be used for authorization, auditing, or execution decisions.
- Schema guidance asks the model not to include secrets or credentials, but sensitive tools should still be opted out when necessary.

## Local testing

Run the automated checks first:

```bash
pnpm --filter @zhcsyncer/pi-tool-display-intent check
```

Then load only this extension so installed renderer extensions cannot compete for the same built-in tool names:

```bash
pi --no-extensions -e ./packages/pi-tool-display-intent
```

In the TUI, run `/tool-display-intent show`, then trigger `read`, `bash`, `grep`, and `edit`. Verify that real tool parameters and model intent appear together, execution matches the original tools, the settings modal opens, and `/reload` restores all renderers. Test the complete repository bundle separately with `pi --no-extensions -e .`.

## Development

```bash
pnpm --filter @zhcsyncer/pi-tool-display-intent typecheck
pnpm --filter @zhcsyncer/pi-tool-display-intent test
pnpm --filter @zhcsyncer/pi-tool-display-intent check
```

## Upstream and attribution

This package is a modified fork of:

- [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display), version `0.5.0`, commit [`91cef7580078371f8dc49a8607222807ad6a424d`](https://github.com/MasuRii/pi-tool-display/commit/91cef7580078371f8dc49a8607222807ad6a424d), Copyright © 2026 MasuRii, MIT License.
- The `displaySummary` schema/delegation mechanism is adapted from [`mertdeveci5/pi-tool-display-summary`](https://github.com/mertdeveci5/pi-tool-display-summary), version `0.1.0`, Copyright © 2026 Mert Deveci, MIT License.

The original `pi-tool-display` license is preserved verbatim in [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE), and its release history is preserved in [`UPSTREAM_CHANGELOG.md`](./UPSTREAM_CHANGELOG.md). The combined copyright and permission notice is in [`LICENSE`](./LICENSE).

Major modifications in this fork include model-written intent schemas, deterministic fallbacks, optional Claude Code-inspired TUI framing, a cooperative custom-tool wrapper, renamed package/config/command namespaces, pnpm workspace integration, and macOS-safe workspace preview path handling.

## License

MIT. See [`LICENSE`](./LICENSE) and [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE).
