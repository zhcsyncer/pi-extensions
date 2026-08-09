# @zhcsyncer/pi-herdr-companion

[简体中文](./README.zh-CN.md)

A standalone Pi package that adds a narrow, ownership-safe companion layer to [Herdr](https://herdr.dev): immutable runtime context, managed long-running process panes, complete `/btw` side threads, and blocked-state adapters.

It does **not** depend on or embed `@ogulcancelik/pi-herdr`. Herdr itself and its managed Pi integration remain external prerequisites.

## Requirements

- Node.js 22.19+
- Pi 0.84+
- Herdr 0.7.5+ (developed against Herdr 0.8.0)
- Pi running inside a Herdr-managed pane for process and `/btw` launch features
- `herdr integration install pi` for Herdr's managed `herdr-agent-state.ts` reporter

Install this package on its own:

```bash
pi install npm:@zhcsyncer/pi-herdr-companion
```

From a checkout:

```bash
pi install /absolute/path/to/pi-extensions/packages/pi-herdr-companion
```

The aggregate `@zhcsyncer/pi-extensions` package embeds the source for release consistency but deliberately does **not** auto-enable this extension. Install the standalone package when you want the companion.

## Capabilities

### Runtime context

The extension captures `HERDR_ENV`, caller pane/tab/workspace IDs, and the socket path once at extension load. Every `before_agent_start` turn receives the same short block, avoiding repeated environment or focused-pane probes.

Inside Herdr it tells the model to use `herdr_process` for dev/preview/watch commands and explains `/btw` merge semantics. Outside Herdr it says that Herdr launch features are unavailable and recommends tmux rather than `nohup`, `&`, or `disown`.

Set `runtime.injectSystemPrompt` to `false` to disable only this prompt block.

### Managed processes

`herdr_process` is one Google-compatible action tool with four actions:

- `start`: split down by default, keep focus on the caller, run a command, optionally wait for literal or regex readiness, then persist ownership
- `list`: reconcile the persisted registry with live Herdr panes
- `logs`: read recent unwrapped output from an owned pane; tail-truncated to Pi's 2,000-line / 50KB limits
- `stop`: close only a companion-created, registered pane

Example calls:

```json
{"action":"start","command":"pnpm dev","readyMatch":"Local:","lifetime":"session"}
{"action":"list"}
{"action":"logs","target":"dev","lines":300}
{"action":"stop","target":"dev"}
```

Start defaults are direction `down`, ratio `0.35`, readiness timeout 60 seconds, cwd equal to Pi's cwd, no focus change, and lifetime `session`. `readyMatch` and `readyRegex` are mutually exclusive.

Ownership is session-persisted and rebuilt after reload/compaction. The tool never closes the caller or an unregistered pane. Lifecycle behavior is:

| Event | `session` process | `persistent` process |
| --- | --- | --- |
| `/reload` | Preserve and reconcile | Preserve and reconcile |
| quit, `/new`, `/resume`, `/fork` | Close on normal teardown | Preserve |
| manual pane close/process loss | Remove stale ownership on reconciliation | Remove stale ownership on reconciliation |

A host/Pi hard crash cannot guarantee pane cleanup. Resume the owning session and call `herdr_process list`/`stop`, or close the known pane in Herdr.

### `/btw` side threads

Parent commands:

```text
/btw
/btw <question>
/btw ask <question>
/btw config ...
/btw merge
/btw help
```

Child commands:

```text
/btw merge <parent follow-up prompt>
/btw merge
/btw help
```

A launch snapshots the parent's active branch with Pi's compaction-aware session builder and inherits cwd, model, thinking level, and active tools by default. The question opens in the child editor unless `auto-submit` is enabled. The child is an independent, visible Pi process: its transcript does not enter the parent until explicit merge.

A merge contains only child user/assistant text, excludes thinking/tool payloads/images, and keeps the newest content within a 48KiB transcript budget. The parent waits until idle, appends one visible context-participating merge message, submits the child-authored follow-up, and durably advances through `message_appended`, `prompt_submitted`, and `acked`. A private file lock, request capability, exact parent-session binding, dispatch lease, and session evidence prevent duplicate delivery across concurrent scans and reload recovery. The child refocuses the parent and closes only after an accepted acknowledgement.

When model, thinking, tools, and effective system prompt exactly match the parent, the child replays the native parent prefix for provider prompt-cache reuse. Any override or unavailable exact system prompt selects a portable flattened snapshot and records the cache-break reason in the child prompt.

Launch payloads and mailboxes live under the global Pi agent directory in a socket-specific private state root. Directories are `0700`, files are `0600`, writes use atomic rename, and capability/context values never appear in CLI argv. Stale cleanup conservatively preserves launches with a live/unknown pane or unacknowledged merge.

### Blocked adapters

The package listens for:

```text
rpiv:ask-user:blocked { active }
```

and safely emits balanced:

```text
herdr:blocked { active, label: "question" }
```

The adapter tracks nested waits and force-clears on `agent_settled` and `session_shutdown`. Listener failures never propagate back into Ask User Question. It is enabled only for Herdr TUI sessions. Plan Mode already emits `herdr:blocked` directly and is intentionally not proxied.

## Configuration

Only the global agent-directory file is read:

```text
$PI_CODING_AGENT_DIR/herdr-companion.json
# default: ~/.pi/agent/herdr-companion.json
```

Project configuration is never accepted. Missing configuration uses defaults and does not create a file. `/btw config ...` creates or updates the global file only after an explicit user command.

```json
{
  "runtime": {
    "injectSystemPrompt": true
  },
  "process": {
    "defaultDirection": "down",
    "defaultRatio": 0.35,
    "readyTimeoutMs": 60000,
    "defaultLifetime": "session"
  },
  "btw": {
    "autoSubmit": false,
    "model": "inherit",
    "thinking": "inherit",
    "tools": "inherit",
    "split": "down"
  },
  "blocked": {
    "askUserQuestion": true
  }
}
```

BTW shortcuts:

```text
/btw config
/btw config auto-submit on|off
/btw config model inherit|provider/model
/btw config thinking inherit|off|minimal|low|medium|high|xhigh|max
/btw config tools inherit|all|read-only|none
/btw config split down|right
/btw config reset
```

`tools: inherit` gives the best cache behavior and full parent capability, but it is not a sandbox. Use `read-only` or `none` when the side thread should not mutate shared files.

## Coexistence and migration

- Keep Herdr's managed `herdr-agent-state.ts`; this package emits into its reserved event bus and does not patch it.
- Remove a separately installed `pi-herdr-btw` to avoid duplicate `/btw` commands.
- Remove the old `herdr-blocked-bridge.ts` after validating the companion adapter, or blocked counts will be duplicated.
- `pi-recap` may continue renaming the caller pane. Companion renames only its own process panes and Herdr names its `/btw` agent pane.
- `@ogulcancelik/pi-herdr` is optional and not a dependency. Install it only if you need its broader layout/agent control surface; companion does not expose general layout, fleets, worktrees, pings, or pickers.

## Security and limitations

- Every Herdr invocation uses argv plus a finite timeout and defensive JSON parsing where the CLI promises JSON.
- Process and BTW ownership registries are separate state machines; one cannot close the other's panes.
- `/btw` shares cwd with the parent. Concurrent file/Git edits, dev servers, and ports can conflict.
- Parent snapshots are static; later parent activity is visible to the child only if the user explains it.
- Merge is bound to the exact parent session ID. If that session is unavailable, the request remains pending and diagnosable.
- Normal failure paths remove private payloads and best-effort close any identified orphan pane. A hard process/host crash or an ambiguous split with no recoverable pane ID cannot offer absolute cleanup guarantees.
- Herdr 0.7.5+ is the compatibility floor; advanced layout operations are intentionally out of scope.

## Development

```bash
pnpm --filter @zhcsyncer/pi-herdr-companion typecheck
pnpm --filter @zhcsyncer/pi-herdr-companion test
pnpm --filter @zhcsyncer/pi-herdr-companion check
npm pack --dry-run ./packages/pi-herdr-companion
```

## License

MIT. The `/btw` product behavior and parts of the private context/mailbox implementation were adapted from MIT-licensed [`pi-herdr-btw@0.3.0`](https://www.npmjs.com/package/pi-herdr-btw) by Oscar Gabriel. Preserved notice and provenance are in [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE) and [`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md).
