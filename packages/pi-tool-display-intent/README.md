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
- Shows the intent beside deterministic metadata such as paths, commands, patterns, and diff information.
- Strips the presentation field before calling the original tool implementation.
- Keeps the raw field available to Pi RPC consumers and retains it in later model context so follow-up calls keep producing intent.
- Uses deterministic per-tool fallbacks when a model or historical call omits the field.
- Sanitizes terminal control sequences and bounds displayed intent length.
- Offers an optional Claude Code-inspired TUI style with status markers, `Name(target)` headers, unboxed rows, and indented `⎿` results.
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

Or install the pinned bundle from Git:

```bash
pi install git:github.com/zhcsyncer/pi-extensions@v0.2.0
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
/tool-display-intent mode compact
/tool-display-intent mode summary
/tool-display-intent mode preview
```

Tool ownership and intent-schema changes take effect after `/reload`. Legacy `preset minimal|balanced|detailed`, `opencode`, and `verbose` command names remain accepted as aliases.

## Configuration

The global config is stored at:

```text
$PI_CODING_AGENT_DIR/extensions/pi-tool-display-intent/config.json
```

When `PI_CODING_AGENT_DIR` is unset, Pi's default agent directory is used. Extension enablement is managed through Pi package settings rather than another config switch. The v2 file is grouped by responsibility and stores only non-default values:

```json
{
  "$schema": "https://raw.githubusercontent.com/zhcsyncer/pi-extensions/main/packages/pi-tool-display-intent/config/config.schema.json",
  "version": 2,
  "intent": {
    "language": "en"
  },
  "toolCalls": {
    "style": "claude"
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
| `toolCalls` | `style` | `compact` or Claude Code-inspired call framing. |
| `results` | `mode`, `previewRows` | Result amount and one shared wrapped-row preview budget. |
| `diff` | `layout`, `indicators`, `splitMinWidth`, `collapsedRows`, `wordWrap` | Edit/write diff presentation. |
| `transcript` | `userMessageStyle`, `thinkingLabel` | User messages and reasoning labels. |
| `tools` | `passthrough`, `custom` | Renderer ownership and explicitly listed custom tools. |
| `advanced` | `expandedRows`, `truncationHints`, `rtkCompactionHints`, `debug` | Expansion safety and diagnostics. |

`results.mode` has one direct meaning:

| Mode | Read/search/MCP | Bash |
|---|---|---|
| `compact` | Hide result bodies | Show a short preview |
| `summary` | Show counts or summaries | Show a line-count summary |
| `preview` | Show content previews | Show a content preview |

Every content preview, including custom tools and bash live/error output, uses `results.previewRows`. It counts terminal rows after wrapping, so a minified JSON object, base64 payload, or other long single line cannot bypass the limit. `advanced.expandedRows` separately caps expanded output.

`tools.passthrough` lists built-in tools whose renderer should remain untouched; it does not disable those tools. A `tools.custom` entry exists only when decoration is enabled, for example: `"web_search": { "renderer": "generic", "mode": "summary" }`.

### Automatic legacy migration

When the extension loads an old flat config without `version`, it normalizes it and atomically replaces `config.json` after a validated v2 round trip. The first migration keeps `config.legacy.json` as a backup. Key mappings are:

- `displaySummary` / `toolIntent` → `intent`;
- `toolCallStyle` → `toolCalls.style`;
- legacy per-tool output modes → one `results.mode`;
- `previewLines` → `results.previewRows`;
- `registerToolOverrides` → `tools.passthrough`;
- `customToolOverrides` → `tools.custom` without an `enabled` switch;
- diff, transcript, hints, and debug → their corresponding sections.

`bashCollapsedLines` is intentionally discarded because all previews now share `results.previewRows`. After migration, the Pi status bar tells the user to adjust that value if needed. Deprecated `displaySummary.required` and `displaySummary.showInTui` are also removed. Invalid JSON, unknown v2 fields, and invalid v2 values are never rewritten and are reported with exact field paths. Run `/reload` after editing the file directly.

When `intent.enabled` is on, `displaySummary` is required in owned built-in schemas and always shown in TUI. If an old or incomplete call omits it, the renderer shows a deterministic fallback and `prepareArguments` backfills the raw arguments. Since Pi emits the initial `tool_execution_start` before preparation, RPC clients should still provide their own fallback for that first event.

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
  overrideExistingRenderers: true
}));
```

`withDisplaySummary`:

- keeps its API-level `required` option for custom tool providers, independently of the built-in `intent` config;
- rejects a tool that already defines a field named `displaySummary`, rather than changing that field's semantics;
- preserves and delegates the original `prepareArguments` and `execute` functions;
- strips the field before both delegation points where appropriate;
- is idempotent.

Pi 0.80.x exposes metadata, not complete arbitrary tool definitions, through `getAllTools()`. Therefore configuration-only discovery should not be treated as a reliable way to add intent schemas to unrelated extensions. Use the cooperative wrapper for schema and execution guarantees. `tools.custom` remains useful for presentation-only decoration where the definition is available.

## RPC and model context

The raw call remains suitable for RPC UI progress:

```json
{
  "path": "docs/tax-code.pdf",
  "displaySummary": "Checking the Colorado tax code"
}
```

The extension retains `displaySummary` in later model context. This small token cost gives the model valid recent examples and prevents resumed or multi-turn runs from teaching the model to omit the required field. Persisted Session and RPC history keep the same argument as well.

## Security and cost

- There is no extra inference request; intent text uses a small number of tokens in the existing model response.
- Intent text is untrusted model output. ANSI/OSC/control sequences, newlines, and excess length are sanitized before TUI display.
- The extension always keeps deterministic paths/commands/patterns visible; intent text must not be used for authorization, auditing, or execution decisions.
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
