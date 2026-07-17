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
pi install git:github.com/zhcsyncer/pi-extensions@v0.1.4
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
/tool-display-intent preset opencode
/tool-display-intent preset balanced
/tool-display-intent preset verbose
```

Tool ownership and intent-schema changes take effect after `/reload`.

## Configuration

The global config is stored at:

```text
$PI_CODING_AGENT_DIR/extensions/pi-tool-display-intent/config.json
```

When `PI_CODING_AGENT_DIR` is unset, Pi's default agent directory is used. A complete template is available at [`config/config.example.json`](./config/config.example.json).

Intent and tool-call style settings:

```json
{
  "displaySummary": {
    "enabled": true,
    "required": true,
    "language": "auto",
    "showInTui": true,
    "maxLength": 96
  },
  "toolCallStyle": "compact"
}
```

| Option | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Add the field to owned built-in tool schemas. |
| `required` | `true` | Mark the field required in the model-facing schema. |
| `language` | `"auto"` | `auto`, `zh-CN`, or `en`. Auto follows the user's primary language. |
| `showInTui` | `true` | Show the sanitized intent beside deterministic call metadata. |
| `maxLength` | `96` | Maximum accepted/displayed length, clamped to 16–256 characters. |
| `toolCallStyle` | `"compact"` | Use `compact` or the optional Claude Code-inspired `claude` framing. Changing it requires `/reload`. |

If an old or incomplete call omits the required field, the renderer immediately shows a deterministic per-tool fallback and `prepareArguments` backfills the raw argument object before validation. Execution can therefore continue, and later TUI/RPC updates can observe the fallback. Since Pi emits the initial `tool_execution_start` before preparation, RPC clients should still provide their own fallback for that first event.

The remaining display settings are inherited from `pi-tool-display`, including:

- `readOutputMode`: `hidden`, `summary`, `preview`
- `searchOutputMode`: `hidden`, `count`, `preview`
- `mcpOutputMode`: `hidden`, `summary`, `preview`
- `bashOutputMode`: `opencode`, `summary`, `preview`
- diff layout, indicators, line limits, ownership, and native user-box settings

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

- rejects a tool that already defines a field named `displaySummary`, rather than changing that field's semantics;
- preserves and delegates the original `prepareArguments` and `execute` functions;
- strips the field before both delegation points where appropriate;
- is idempotent.

Pi 0.80.x exposes metadata, not complete arbitrary tool definitions, through `getAllTools()`. Therefore configuration-only discovery should not be treated as a reliable way to add intent schemas to unrelated extensions. Use the cooperative wrapper for schema and execution guarantees. `customToolOverrides` remains useful for presentation-only decoration where the definition is available.

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
