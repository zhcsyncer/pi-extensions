# @zhcsyncer/pi-consult

[简体中文](./README.zh-CN.md)

A second-opinion primitive for the [Pi coding agent](https://pi.dev). The main model calls `consult({ why })`; an advisor model with no tools answers plan / correction / stop. A loop gate can force that call. Optional dual-path panel. Local behavior log.

This package is also included in `@zhcsyncer/pi-extensions`.

## Source

New package. Side-call, inventory prefix, and active-tool reconcile are adapted from MIT-licensed [`@juicesharp/rpiv-advisor`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor) 2.8.0. The tool is `consult` (required `why`), configuration is a panel array, and this package adds a loop gate, budgets, and a local jsonl log. It is not a fork.

## Features

- `consult({ why })` forwards the current session to the configured advisor. The advisor has no tools and no user-visible output.
- Unconfigured panel unloads the tool. Off costs nothing.
- Loop gate: after N identical tool calls or N consecutive errors, steer the model to consult first. The default threshold is 5; completing Consult clears the prior loop evidence.
- `/consult` picks panel models and effort and toggles the loop gate. `/consult status` opens a temporary dashboard for budget and recent activity without adding anything to the transcript.
- Advisor summaries follow the language of the user's latest substantive request while preserving technical syntax. Expanded results render Markdown; collapsed rows remain clean one-line previews.
- Waiting rows stream `connecting` / `thinking` / `writing` and an approximate `~out` count. Completed expanded rows and the status dashboard show exact input, output, and total tokens only.
- Full advisor usage still includes retries, fanout, cache reads/writes, and cost and is attached to the Consult tool result for Pi/pi-meter accounting; cache and cost stay out of the Consult UI.

## Install

Standalone:

```bash
pi install npm:@zhcsyncer/pi-consult
```

Or install the whole extension bundle:

```bash
pi install npm:@zhcsyncer/pi-extensions
```

Try without installing:

```bash
pi -e npm:@zhcsyncer/pi-consult
```

Then restart Pi or run `/reload`. Use `/consult` to choose an advisor model. Until a panel is set, `consult` is not in the active tools.

## Commands

| Command | What you see |
|---|---|
| `/consult` | Panel, effort, fanout, loop gate |
| `/consult status` | Temporary panel/budget/recent-activity dashboard; `q`/Esc closes it without writing to the transcript |

After each `consult` result, the next visible reply should add:

```text
CONSULT-LOG: adopt|reject | <reason>
```

The line remains normal assistant output and its decision is also mirrored under the matching Consult row. The TUI distinguishes streamed `connecting` / `thinking` / `writing`, advisor verdicts, policy `blocked`, request `failed`, and user `cancelled` states.

## Configuration

Global file: `$PI_CODING_AGENT_DIR/extension-data/pi-consult/config.json` (normally `~/.pi/agent/extension-data/pi-consult/config.json`).

```json
{
  "panel": [{ "model": "anthropic/claude-fable-5", "effort": "high" }],
  "fanout": false,
  "gates": { "loop": 5 },
  "budget": { "perRun": 3, "perSession": 8 },
  "disabledForModels": []
}
```

Empty `panel` keeps the tool unloaded. `fanout: true` asks the whole panel on an explicit `consult()`; auto gates always use the first advisor only. `perRun` spans one real user input through all following model/tool rounds; the next user input resets it. Budgets count started advisor requests, including attempts that later fail or are cancelled. Legacy `perTurn` is accepted as an alias. Behavior log: `$PI_CODING_AGENT_DIR/extension-data/pi-consult/events.jsonl`.

## License

MIT

Side-call helpers are adapted from MIT-licensed [`@juicesharp/rpiv-advisor`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor) 2.8.0.
