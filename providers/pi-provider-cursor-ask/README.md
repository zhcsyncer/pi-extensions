# pi-provider-cursor-ask

[简体中文](./README.zh-CN.md)

A standalone [Pi](https://github.com/badlogic/pi-mono) provider for focused advisor, adversarial-review, and single-turn question workflows through Cursor.

This is an unofficial community fork and is not affiliated with or endorsed by Cursor or the upstream project.

## Source and differences

The package is a full fork of [`@rahularya01/pi-cursor`](https://github.com/Rahularya01/pi-cursor) `v1.4.25` (`5f8e775279f5e41cdd06791a036be4c7141097c3`). It retains the upstream native Cursor OAuth, credential discovery, streaming, tool use, image input, usage, diagnostics, and model discovery capabilities.

The fork differs in these user-visible ways:

- Replaces the upstream extension under the same `cursor` provider/login identity and `cursor-native` stream API.
- Keeps tool execution in Pi: requests with Pi tools expose only the Cursor MCP tool family; tool-free questions disable Cursor tools. Cursor-native filesystem, shell, and subagent tools are not offered.
- Maps only a curated subset of Cursor models, not the full catalog: five always-thinking 1M Claude rows, Composer 2.5 / Composer 2.5 Fast, and Grok 4.6 / Grok 4.6 Fast when the live account catalog includes them. Other Cursor families are not registered.
- Uses readable picker names without a separate default-context row, because Cursor bills these Claude models at one rate up to 1M.
- Maps only advertised Pi thinking levels. Claude uses Cursor `effort`. Composer 2.5 has no effort parameter, so `off`/`max` are an explicit Max Mode switch and other levels stay unavailable. Grok keeps upstream `low`/`medium`/`high`/`xhigh` routing instead of the Claude 1M rebuild.
- Publishes independently as `pi-provider-cursor-ask` and is not included in `@zhcsyncer/pi-extensions`.

See [`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md) for the maintained fork record.

## Models

This package maps only the models below. The rest of the Cursor catalog is omitted.

- Fable 5.1
- Fable 5
- Opus 5
- Opus 4.6
- Sonnet 5
- Composer 2.5 / Composer 2.5 Fast
- Grok 4.6 / Grok 4.6 Fast (only when the account catalog includes them)

Thinking cannot be disabled on the five Claude rows. Depending on Cursor's metadata for a Claude model, Pi may offer `low`, `medium`, `high`, `xhigh`, and `max`; unavailable levels are omitted. Composer 2.5 exposes only `off` (standard) and `max` (Max Mode). Grok exposes `low`, `medium`, `high`, and `xhigh`.

## Requirements

- Node.js 22.19 or newer.
- Pi 0.80 or a compatible newer release.
- A Cursor account entitled to use the selected model.

## Install

```bash
pi install npm:pi-provider-cursor-ask
```

Restart Pi or run `/reload`, then sign in:

```text
/login cursor
```

The provider can also reuse supported Cursor CLI or desktop credentials. For automated environments, set `CURSOR_ACCESS_TOKEN`.

## Use

List the filtered models:

```bash
pi --list-models cursor
```

Select `cursor/fable-5.1`, `cursor/fable-5`, `cursor/opus-5`, `cursor/opus-4.6`, `cursor/sonnet-5`, or, when advertised, `cursor/grok-4.6` / `cursor/grok-4.6-fast`.

Available command:

- `/cursor usage` — open a dashboard of Cursor plan usage.
- `/cursor doctor` — open a dashboard of sanitized provider diagnostics.

If Cursor requests history that is no longer available locally, the current generation fails with `Refusing to answer empty` instead of sending incomplete history. Retry to rebuild from Pi's conversation history.

If `@zhcsyncer/pi-meter` is also loaded, the footer follows the current Cursor model: Composer uses the Auto pool, and Claude rows use the API pool.

This package intentionally owns the `cursor` provider id as a drop-in replacement. Do not load it together with `@rahularya01/pi-cursor`; whichever extension registers last would replace the other's `cursor` catalog.

## Security

This fork retains upstream support for local Cursor CLI/desktop credential discovery and the existing Pi `cursor` credential entry. Set `PI_CURSOR_SYSTEM_CREDENTIALS=0` before starting Pi to disable local credential discovery and use `/login cursor` or `CURSOR_ACCESS_TOKEN` instead.

Extensions run with your user permissions. Review the package before installation and never commit or paste credentials into issue reports.

## License

MIT. The upstream copyright and license notice are preserved in [`LICENSE`](./LICENSE).
