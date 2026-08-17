# @zhcsyncer/pi-meter

[简体中文](./README.zh-CN.md)

Usage meter for the [Pi coding agent](https://pi.dev). One `/usage` command answers two questions: how much of a subscription window is left, and where local tokens and cost went.

This package is also included in `@zhcsyncer/pi-extensions`.

## Sources

This package combines two existing Pi extensions:

| Source | What you already know | What this package changes |
|---|---|---|
| [`pi-tracker`](https://github.com/alpertarhan/pi-tracker) | Local token/cost ledger, dashboard, budgets, session import | Those live under `/usage`, not `/analytics`. Counts use `34k` / `4.3M` / `5.35B`. |
| [`@pi-plugins/usage`](https://github.com/k3dom/pi-plugins/tree/main/plugins/usage) | Claude and Codex subscription windows | Those live under `/usage quota`. SuperGrok and Ollama Cloud are included. |

Do **not** load `@pi-plugins/usage` at the same time. Both register `/usage`. If both are present, this package warns once and continues.

`pi-tracker` can stay loaded for comparison, but this package owns `/usage`.

## Features

- Footer line for today's local spend next to the current subscription window:

  ```text
  · today 12.4k $0.18 · week left ███░░ 49% (1d 23h)
  ```

- Local dashboard by model, project, or session.
- Claude, Codex, SuperGrok, and Ollama Cloud remaining after `/login` for that provider.
- Optional local budgets. They warn; they never block requests.
- Optional one-time import from older session files.

`--no-session` and ordinary sub-agents still record local usage. Isolated sub-agents do not.

## Install

Standalone:

```bash
pi install npm:@zhcsyncer/pi-meter
```

Or install the whole extension bundle:

```bash
pi install npm:@zhcsyncer/pi-extensions
```

Try without installing:

```bash
pi -e npm:@zhcsyncer/pi-meter
```

Then restart Pi or run `/reload`. If `@pi-plugins/usage` is already in `settings.json`, remove it.

## Commands

| Command | What you see |
|---|---|
| `/usage` | Menu: dashboard, quota, footer, budgets, import |
| `/usage quota` | Open the remaining/reset-time dashboard for Claude, Codex, SuperGrok, and Ollama Cloud |
| `/usage quota refresh` | Refresh subscription windows now |
| `/usage quota used` / `remaining` | Show used or remaining in the footer |
| `/usage quota on` / `off` | Show or hide the quota half of the footer |
| `/usage footer` | Choose the local half: today spend, tokens, cost, budget, model, or off |
| `/usage import` | Back-fill from session files |
| `/usage budget` | View or add a local budget |

## License

MIT

Local-ledger ideas come from MIT-licensed [`pi-tracker`](https://github.com/alpertarhan/pi-tracker). Subscription-window ideas come from MIT-licensed [`@pi-plugins/usage`](https://github.com/k3dom/pi-plugins/tree/main/plugins/usage).
