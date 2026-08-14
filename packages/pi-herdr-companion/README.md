# @zhcsyncer/pi-herdr-companion

[简体中文](./README.zh-CN.md)

A standalone Pi extension for using Pi inside [Herdr](https://herdr.dev). It provides visible long-running process panes, minimal asynchronous Pi Worker dispatch, temporary `/btw` side threads, configurable blocked-state reporting, and one settings UI.

## What it adds

| Capability | What you get |
| --- | --- |
| Herdr context | Pi receives a stable Herdr caller identity without repeatedly probing focus or environment state. |
| Managed processes | Start, inspect, and stop owned long-running commands, with a navigable TUI process widget. |
| Pi Workers | Start one Pi Worker in an existing Herdr pane and receive its explicit final report asynchronously. |
| `/btw` side threads | Explore a question in a temporary Pi conversation and merge it back only when you ask. |
| Blocked reporting | Show configured tools or extension events as blocked in Herdr. |
| Unified settings | Configure runtime guidance, process defaults, and blocked reporting through `/herdr-config`. |

## Requirements and installation

- Node.js 22.19+
- Pi 0.84+
- Herdr 0.7.5+ for core process management (developed against Herdr 0.8.0)
- Bash on POSIX for the default process shell; Windows uses the pane's shell
- Herdr's Pi integration:

```bash
herdr integration install pi
```

Install the standalone package:

```bash
pi install npm:@zhcsyncer/pi-herdr-companion
```

From a checkout:

```bash
pi install /absolute/path/to/pi-extensions/packages/pi-herdr-companion
```

The aggregate `@zhcsyncer/pi-extensions` package includes these sources for release consistency but does **not** enable the companion. Install it separately or add it explicitly to Pi.

The extension is silent when Pi is outside Herdr or Herdr cannot identify the calling pane. `herdr_process`, `herdr_worker`, and blocked reporting work in TUI, RPC, JSON, and print modes; `/btw` and `/herdr-config` require Pi's TUI mode.

## Minimal Pi Workers

Use `herdr_worker` when an existing Herdr pane is already at an available shell prompt and should run one asynchronous Pi task:

```json
{"paneId":"w1:p4","name":"reviewer","prompt":"Review the current diff and report only actionable findings."}
```

The Worker name must be unique among live Herdr agents and match `[a-z][a-z0-9_-]{0,31}`. On the first actual dispatch only, the caller reuses its existing Herdr agent name or lazily derives and assigns a stable name from the current Pi session ID. Merely loading the companion never renames a normal Pi session.

The tool starts `pi` in the supplied pane with a short callback contract, submits the task as a normal user prompt without `--wait`, and returns after submission. The Worker must send exactly one explicit final success or confirmed-failure report beginning with `[pi-herdr-worker-report:v1]`. The parent converts that ordinary Herdr prompt input into a triggered Pi `followUp`, so a report arriving while the parent is busy does not steer the active turn. Herdr `idle` and `done` are deliberately not completion signals.

This is an online, best-effort handoff rather than a durable job system. The parent and Worker must remain live in the same Herdr server long enough to exchange the report. There is no persistence, task ledger, polling, status tracking, restart recovery, retry, batching, pane/worktree creation, or automatic cleanup. A failure after Pi starts but before the task prompt is accepted can leave an idle Worker for manual inspection or cleanup.

## Managed processes

Use `herdr_process` for dev servers, previews, watchers, and other commands that must keep running visibly:

- `start` creates an owned pane and optionally waits for readiness.
- `list` shows owned panes and their current state.
- `logs` reads bounded recent output.
- `stop` closes only a pane created and recorded by the companion.

Examples:

```json
{"action":"start","label":"dev","command":"pnpm dev","readyMatch":"Local:","lifetime":"session"}
{"action":"list"}
{"action":"logs","target":"dev","lines":300}
{"action":"stop","target":"dev"}
```

Defaults are a downward `0.35` split, Pi's current working directory, no focus change, a 60-second readiness timeout, and `lifetime: "session"`. `/btw` uses the same configured split direction.

### TUI process widget

When at least one managed process exists, Pi TUI shows a live process list below the editor. With an empty editor:

- press `→` to activate the list;
- use `↑` / `↓` to select a process;
- press `s`, then confirm, to stop it through the same ownership checks as `herdr_process stop`;
- press `Esc` to return to the editor.

The widget marks panes containing an agent session and warns that stopping one will close that session. It deliberately has no Logs action: use `herdr_process logs` when the model needs to inspect output without changing focus. Tool rows stay compact in the transcript and reveal commands, current locations, process rows, or the bounded log body when Pi's tool output is expanded.

On POSIX, commands use `shell: "bash"` by default, so Bash syntax is not reinterpreted by Fish or another interactive pane shell. Use `shell: "pane"` only when the command intentionally uses that shell's syntax. Windows defaults to `pane` and does not offer the Bash transport.

`readyMatch` and `readyRegex` are mutually exclusive. A readiness marker must not be satisfiable by an echoed launch line; use a more specific marker or anchored regex when necessary.

### Process lifetime

| Event | `session` | `persistent` |
| --- | --- | --- |
| `/reload` or `/tree` | Preserve and refresh the current pane address | Preserve and refresh the current pane address |
| quit, `/new`, `/resume`, or `/fork` | Close on normal teardown | Keep in its owning session |
| command exits back to the shell | Keep logs until teardown or `stop` | Keep logs until `stop` |
| pane is closed manually | Remove it from the managed-process list when state is refreshed | Same |

A start still waiting for readiness is canceled and closed when the Pi session reloads or changes. Moving an owned pane to another tab or workspace changes its public pane ID, but the companion keeps following the same live terminal within the same Herdr server.

Before lifecycle cleanup closes a pane, the companion refreshes Herdr's live pane list and verifies the stored terminal identity. If that verification fails, it leaves the visible pane/process running for manual cleanup rather than risk closing the caller pane or an unowned pane. Use `herdr_process list` and `stop`, or close the verified pane directly in Herdr.

## Temporary `/btw` side threads

From a parent session:

```text
/btw
/btw <question>
/btw ask <question>
/btw merge
/btw help
```

From the child:

```text
/btw merge <parent follow-up prompt>
/btw merge
/btw help
```

A launch takes a static snapshot of the current parent branch, shares its cwd, and inherits its model and thinking level. The child uses Pi's normal default tools. A supplied question is submitted immediately; bare `/btw` opens an empty child. The child is a separate visible Pi process, and its conversation does not enter the parent until an explicit merge.

The child is **temporary and not saved as a Pi session**. Closing it before merge permanently loses the unmerged child conversation. Private coordination files may remain briefly for delivery and cleanup, but they are not a recoverable transcript.

A merge sends child user/assistant text to the exact parent session. Tool calls, thinking, and images are excluded, and the newest text is kept within a 48 KiB limit. If the parent is closed or busy, the request waits; reopen the exact parent session and use `/btw merge` to scan pending requests.

After the parent confirms delivery, the child normally focuses the parent and closes itself. If Herdr cannot confirm focus or cleanup, the child stays open and reports what must be closed manually.

`/reload` keeps a child usable when the Pi session ID is unchanged. Using `/new`, `/resume`, or `/fork` inside the child changes its identity and disconnects it from the parent; merge is then unavailable, and the child can continue only as an independent Pi session.

## Blocked-state reporting

The companion can report two kinds of configured source as blocked in Herdr:

- a Pi tool while that tool call is running;
- an extension event whose payload is `{ active: true }`, cleared by `{ active: false }`.

Rules use an exact source name and a display label. The default tracks `ask_user_question` as `question`; extension-event rules are empty by default.

## Configuration

Open the settings UI in Pi TUI mode:

```text
/herdr-config
```

Use `/herdr-config reset` to reset every companion setting.

Configuration is stored only at:

```text
$PI_CODING_AGENT_DIR/extension-data/pi-herdr-companion/config.json
# default: ~/.pi/agent/extension-data/pi-herdr-companion/config.json
```

No file is created until you save a setting.

```json
{
  "runtime": {
    "injectSystemPrompt": true
  },
  "process": {
    "defaultDirection": "down",
    "defaultRatio": 0.35,
    "readyTimeoutMs": 60000,
    "defaultLifetime": "session",
    "defaultShell": "bash"
  },
  "blocked": {
    "events": [],
    "tools": [
      { "name": "ask_user_question", "label": "question" }
    ]
  }
}
```

The example shows the POSIX shell default; Windows uses `"defaultShell": "pane"`. `runtime.injectSystemPrompt` controls whether Herdr guidance is appended to each model call's system prompt; turning it off does not disable the tools themselves.

In the blocked-rule editors, enter one `exact_name = Herdr label` rule per line:

```text
review:blocked = review
approval_tool = approval
```

## Operational limits

- Keep Herdr's managed Pi integration installed; the companion does not replace it.
- Do not load another extension that registers `/btw`, or Pi will expose duplicate suffixed commands.
- Parent snapshots are static, and parent and child share a cwd. Concurrent file edits, Git operations, servers, and ports can conflict.
- A hard process or host crash cannot guarantee pane cleanup. Resume the owning session and use `herdr_process list`/`stop`, or close the known pane in Herdr.
- Terminal identity is scoped to one Herdr server/socket and is not preserved across a cold server restart; stale ownership is removed rather than applied to a different terminal.
- Managed-process ownership covers only panes created by `herdr_process`. `herdr_worker` starts Pi only in the caller-supplied pane and never assumes pane ownership or cleanup; general layout, worktree, and agent controls remain Herdr CLI responsibilities.

## Development

```bash
pnpm --filter @zhcsyncer/pi-herdr-companion typecheck
pnpm --filter @zhcsyncer/pi-herdr-companion test
pnpm --filter @zhcsyncer/pi-herdr-companion check
npm pack --dry-run ./packages/pi-herdr-companion
```

## License

MIT. The `/btw` product behavior and parts of its private coordination mechanism were adapted from MIT-licensed [`pi-herdr-btw@0.3.0`](https://www.npmjs.com/package/pi-herdr-btw) by Oscar Gabriel. Preserved notice and provenance are in [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE) and [`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md).
