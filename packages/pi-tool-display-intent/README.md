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
- Offers an optional aggregate layout that combines owned safe built-ins into one bounded Activity per user request.
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

`toolCalls.layout` defaults to `individual`, which preserves the complete existing per-tool behavior. `aggregate` combines this extension's owned `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write` calls within one user request:

```text
◐ Activity · read ×12 · edit ×8 · bash ×16
  ◐ Bash(pnpm test)

✓ Activity · read ×12 · edit ×8 · bash ×17
  ✓ Bash(pnpm test) done
```

The latest aggregate-safe tool row carries Activity; older group members occupy zero rows. Up to three running or recently completed operations appear in assistant source order. A successful row changes to `done` instead of disappearing immediately; a newer tool replaces the oldest retained `done` row, while running tools always take slot priority. After Pi reports the agent settled, the final successful row remains for a 1.5-second grace period and then folds into the header counts. Failures remain visible and do not auto-fold.

Tools use distinct theme-aware colors, with bold high-emphasis styling for `edit` and `write`. Changed-file paths use the theme accent, while additions and deletions use `toolDiffAdded` and `toolDiffRemoved`. Labels and status symbols remain present, so color is never the only distinction. Edit/write operations also include unique-file and exact available `+A −B` statistics; file statistics are placed before tool counts so they survive narrow headers. Groups continue across low-level assistant/tool turns and end only at the next user message.

Aggregate stays bounded: transient `done` rows are live-only and are not reconstructed after reload, resume, tree navigation, or compaction. `Ctrl+O` expands only up to 20 changed-file paths with per-file available `+A −B` statistics; it never reveals grouped output or diff bodies and does not add `displaySummary` to owned schemas. When Pi hides reasoning blocks, pure assistant `Thinking...` placeholder rows are also suppressed in aggregate, while assistant text, errors, and reasoning revealed with Pi's thinking toggle remain visible. Images, interactive or attention-requiring results, passthrough tools, externally owned tools, and unknown/custom tools remain independent instead of being silently hidden. Reload, resume, tree navigation, and compaction rebuild Activity from the current session branch without changing the stored raw calls or results. Exact write diff counts that were available at execution time are retained in an invisible extension custom entry, so rebuilt Activity statistics stay stable without persisting previous file content.

Individual-only preferences remain in `config.json` while aggregate is active. The settings TUI hides them, and `/tool-display-intent show` marks them inactive. Layout changes take effect after `/reload` and redraw the whole current branch, not only future calls. To inspect historical raw details, switch back and reload:

```text
/tool-display-intent layout individual
/reload
```

Calls created while aggregate was active have no generated intent; individual history uses deterministic targets and the original stored results.

`toolCalls.bashCommandPreviewRows` is a separate `1`–`8` wrapped-row budget for Bash command arguments and defaults to `1`. Short commands stay inline. Long or multiline commands collapse with exact line/size metadata; Claude-style calls keep intent in the header, put the command preview on its own row, and emphasize that row's shell prompt with the accent color. `Ctrl+O` reveals the complete original command and applies Bash syntax highlighting within safety limits. This setting does not affect command output. Claude-style Bash results use a connected left gutter through their final row in both collapsed and expanded views.

Path-bearing `read`, `grep`, `find`, `ls`, `edit`, and `write` calls keep short paths unchanged. When a full call header would wrap, the collapsed view removes middle path segments while preserving useful leading directories and the basename. `Ctrl+O` restores every path segment and lets the full header wrap normally; home paths remain normalized with `~`.

Model-written intent uses the theme's regular `accent` color without bold or background styling. Deterministic commands, paths, and queries use normal `text`; metadata, separators, and deterministic fallback intents remain `muted`.

`tools.passthrough` lists built-in tools whose renderer should remain untouched; it does not disable those tools. A `tools.custom` entry exists only when decoration is enabled, for example: `"web_search": { "renderer": "generic", "mode": "summary" }`. The bundle-private Search Hub already uses the cooperative API, so it needs no such entry unless you want to pin a mode instead of inheriting `results.mode`.

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
