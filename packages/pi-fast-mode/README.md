# pi-fast-mode

[简体中文](./README.zh-CN.md)

`pi-fast-mode` asks the **same model** for higher scheduling priority. It is not a faster model variant and it is not a thinking-level control.

## Features

- Toggle Fast / Priority with `/fast` or `Ctrl+F`.
- Keep each model's current switch in memory only. It is never written to the session jsonl.
- Set the next-process default for the **current model** with `/fast default on|off`. That command also turns the current session switch to match.
- Unconfigured models start off. There is no all-models default.
- Show a footer status on supported models. Hide it on unsupported models and leave the request unchanged.

Requires Pi 1.2 or later. Fast applies only to normal Agent requests in the current Pi main session, not direct SDK calls made by extensions such as Consult or Recap. Pi retains control of request hooks, sampling and output budgets; Fast does not change your model, authentication, endpoint, or pricing configuration.

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

Write this model's startup default and turn the current session switch to match. Unsupported models reject the command.

There is no `/fast status` command and no `gpt-fast-mode` compatibility alias.

## Settings

Defaults are a list of `provider/id` in Pi `settings.json`. Only listed models start Fast:

```json
{
  "fast-mode": {
    "models": ["openai/gpt-5.6"]
  }
}
```

`/fast default` is the supported way to change that list. Manual edits are read on `/reload` or process restart. An old `fast-mode.enabled` boolean or `{ "provider/id": true }` map is rewritten on startup or `/reload`. A former global ON does not enable every model; Fast Mode posts a warning in the chat when that happens.

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

Unsupported models hide the footer and leave the request unchanged. Turning Fast off stops overriding `service_tier`; it does not remove a tier supplied by your own configuration. Fast does not write `models.json`.

## Pricing and billing

Do not assume every model is granted priority.

- OpenAI Fast / priority is officially priced for the GPT-5.6 family. Older models may reject or ignore the request.
- Fast requests `priority` but does not adjust Pi's local cost estimates. Those estimates may differ from the provider's actual priority charges; the provider's bill is authoritative.
- This also applies to custom xAI Completions models. A Fast footer badge indicates the requested mode, not confirmation of the granted tier or price.

## Session lifetime

- `/fast` and `Ctrl+F` change the current model's in-memory switch only.
- Switching models follows that model's switch. First use reads its startup default, or off if it has none.
- `/new`, `/resume`, and `/fork` in the same Pi process keep each model's current switch.
- `/reload` or a process restart rereads per-model defaults from `settings.json`.
- `/fast default on|off` writes the current model's settings default and turns this session's switch to match.
