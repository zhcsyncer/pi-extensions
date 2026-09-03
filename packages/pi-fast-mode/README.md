# pi-fast-mode

[简体中文](./README.zh-CN.md)

`pi-fast-mode` asks the **same model** for higher scheduling priority. It is not a faster model variant and it is not a thinking-level control.

## Features

- Toggle Fast / Priority with `/fast` or `Ctrl+F`.
- Keep each model's current switch in memory only. It is never written to the session jsonl.
- Set the next-process default for the **current model** with `/fast default on|off`. That command writes `settings.json` only and does not change the current switch.
- Unconfigured models start off. There is no all-models default.
- Show a footer status on supported models. Hide it on unsupported models and leave the request unchanged.

## Install

```bash
pi install npm:@zhcsyncer/pi-fast-mode
# or via the root bundle
pi install npm:@zhcsyncer/pi-extensions
# local
pi -e ./packages/pi-fast-mode
```

The root Git bundle also includes this extension:

```bash
pi install git:github.com/zhcsyncer/pi-extensions
```

## Commands

```text
/fast
/fast on
/fast off
```

Toggle or set the **current** in-memory switch. `Ctrl+F` is the same toggle, with a short repeat guard so a held key does not flip the switch repeatedly. Releasing the key does not toggle again.

```text
/fast default on
/fast default off
```

Write only this model's startup default. The current switch stays as it is. Unsupported models reject the command.

There is no `/fast status` command and no `gpt-fast-mode` compatibility alias.

## Settings

Defaults are stored per `provider/id` in Pi `settings.json`. Only listed models start Fast:

```json
{
  "fast-mode": {
    "models": {
      "openai/gpt-5.6": true
    }
  }
}
```

`/fast default` is the supported way to change that map. Manual edits are read on `/reload` or process restart. The old `fast-mode.enabled` boolean is ignored.

## Footer

![Fast Mode footer status](./assets/demo-fast-mode-status.png)

- Supported model, on: `⚡ FAST`
- Supported model, off: dim `fast`
- Unsupported model: hide the status and do not mutate the request
- `/fast` and `Ctrl+F` update the footer only. They do not add a chat notification.

## Supported providers

The provider list is fixed. There is no user allowlist.

- OpenAI and Codex request `priority` when Fast Mode is on.
- Pi's built-in xAI models all use Responses and request `priority` when Fast Mode is on.
- Custom xAI Completions models in `models.json` remain supported.

Unsupported models hide the footer and leave the request unchanged.

## Pricing and billing

Do not assume every model is granted priority.

- OpenAI Fast / priority is officially priced for the GPT-5.6 family. Older models may reject or ignore the request.
- On Responses models, Pi uses the returned `service_tier` for local `usage.cost`: `priority` is typically about 2×, while `default` stays at 1×.
- Custom xAI Completions models can request priority, but their local cost does not receive the Responses-specific adjustment.

## Session lifetime

- `/fast` and `Ctrl+F` change the current model's in-memory switch only.
- Switching models follows that model's switch. First use reads its startup default, or off if it has none.
- `/new`, `/resume`, and `/fork` in the same Pi process keep each model's current switch.
- `/reload` or a process restart rereads per-model defaults from `settings.json`.
- `/fast default on|off` writes only the current model's settings default.
