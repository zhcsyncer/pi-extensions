# @zhcsyncer/pi-meter

[简体中文](./README.zh-CN.md)

Local usage ledger plus subscription remaining for the [Pi coding agent](https://pi.dev). It answers two separate questions: how much of a subscription window is left, and where local tokens and cost went.

This package is also embedded in the aggregate `@zhcsyncer/pi-extensions` bundle.

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

## Mutual exclusion

Do **not** load `@pi-plugins/usage` at the same time. Both register `/usage`. Disable that plugin after installing this package. If both are present, pi-meter warns once and continues.

`pi-tracker` can coexist for comparison, but this package owns `/analytics` and `/budget` for the local ledger.

## Commands

| Command | What you see |
|---|---|
| `/usage` | Claude, Codex, and SuperGrok window percent plus reset time |
| `/usage refresh` | Force-refresh shared snapshots (still respects the 30s min interval) |
| `/usage used` / `/usage remaining` | Flip the footer status between used and remaining |
| `/analytics` | TUI menu: dashboard, footer preset, budgets, import |
| `/analytics footer` | Restore the old tracker footer: today tokens / cost / budget / model, or the combined today + quota view |
| `/analytics import` | Optional one-time back-fill from session JSONL |
| `/analytics details` | Toggle input / output / cache hit in the footer status |
| `/budget` | Local token/cost reminders. They never block requests |

`--no-session` and default memory sub-agents still append to the local ledger when the extension is loaded. Isolated sub-agents (`isolated: true` / `extensions: false`) do not.

## Persistent chrome

The chrome is one footer `setStatus` string (`pi-meter`). It does not take a widget row, and it is not drawn inside Glance's input box. The words name the window so the numbers are not ambiguous:

```text
· today 12.4k $0.18 · week left ███░░ 49% (1d 23h)
```

With token details on:

```text
· today ↑12.4k ↓2.1k hit 80k · week left ███░░ 49% (1d 23h)
```

`today` is local spend from the ledger. `week left` / `5h left` is the current subscription window. Quota color follows remaining headroom (about 30% warning, 15% error), even when the numbers show used percent.

## Two ledgers

Remote remaining and local spend are not the same thing:

- **Quota** comes from each provider's subscription API and lives in a shared snapshot. It is never written into the local usage log or local budgets.
- **Ledger** comes from Pi `message_end` usage and is appended per process. `/analytics` and `/budget` only see this book.

SuperGrok uses the verified Grok CLI billing JSON (`GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`) with Pi `/login xai` OAuth. It does not call `api.x.ai/v1/api-key` and does not use grok.com gRPC. Only the weekly credit pool is shown; product splits such as Build / Chat are omitted.

Subscription fetches run only from `ctx.hasUI === true` root sessions, and only on `agent_settled`, `/usage`, or `model_select`. Shared `quota.json` uses a 60s TTL and a 30s minimum interval. Sub-agents without UI still write the local ledger and never hit subscription APIs.

## Storage

All files live under `$PI_CODING_AGENT_DIR/extension-data/pi-meter/`:

```text
config.json    polarity, token details, TTL
quota.json     shared subscription snapshot
usage.jsonl    local ledger
budgets.json   local limits
warned.jsonl   one-shot budget warnings
```

An existing `analytics/usage.jsonl` and `analytics/footer.json` from pi-tracker are migrated into this directory on first load.

## Configuration

Optional `config.json`:

```json
{
  "quotaPolarity": "remaining",
  "tokenDetails": false,
  "snapshotTtlMs": 60000,
  "minRefreshIntervalMs": 30000
}
```

Commands persist polarity and token-detail changes. Auth stays in Pi `/login`; this package never prints tokens, emails, or user ids.

## Local development

```bash
pnpm --filter @zhcsyncer/pi-meter check
pi --no-extensions -e ./packages/pi-meter --list-models nope
```

## License

MIT
