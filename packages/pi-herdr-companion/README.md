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

Inside a complete Herdr caller it tells the model to use `herdr_process` for dev/preview/watch commands and explains `/btw` merge semantics. Outside Herdr it says that Herdr launch features are unavailable and recommends tmux rather than `nohup`, `&`, or `disown`. If `HERDR_ENV=1` but caller pane or socket identity is missing, the block reports `degraded/unavailable` and does not advertise the unregistered process tool.

Set `runtime.injectSystemPrompt` to `false` to disable only this prompt block.

### Managed processes

`herdr_process` is one Google-compatible action tool with four actions:

- `start`: split down by default, keep focus on the caller, run a command, optionally wait for literal or regex readiness, then persist ownership
- `list`: reconcile the persisted registry with live Herdr panes
- `logs`: merge bounded `recent-unwrapped` scrollback with the current `visible` viewport, removing their largest exact line overlap before Pi's final 2,000-line / 50KB tail truncation. This preserves short output that Herdr 0.8 may expose only through `visible`; one non-missing source failure falls back to the other
- `stop`: close only a companion-created, registered pane

Example calls:

```json
{"action":"start","command":"pnpm dev","readyMatch":"Local:","lifetime":"session"}
{"action":"list"}
{"action":"logs","target":"dev","lines":300}
{"action":"stop","target":"dev"}
```

Start defaults are direction `down`, ratio `0.35`, readiness timeout 60 seconds, cwd equal to Pi's cwd, no focus change, and lifetime `session`. `readyMatch` and `readyRegex` are mutually exclusive. Because Herdr `wait-output` can see shell command echo, a literal `readyMatch` that occurs in `command` is rejected before splitting. Use a marker absent from the command, or an anchored `readyRegex` such as `^READY$` whose pattern text cannot match the echoed command line.

Ownership is session-persisted and rebuilt after reload/compaction. `/tree` navigation first merges the runtime's current ownership with branch-only records bound to the exact session and caller, persists that conservative union on the selected branch, and only then reconciles live pane/process state. A transient pane-list failure therefore loses neither current nor valid branch ownership; missing or unreliable process information remains non-destructive. The tool never closes the caller or an unregistered pane. Lifecycle behavior is:

| Event | `session` process | `persistent` process |
| --- | --- | --- |
| `/reload` | Preserve and reconcile | Preserve and reconcile |
| `/tree` | Preserve live runtime ownership and rebind it to the selected branch | Same |
| quit, `/new`, `/resume`, `/fork` | Close on normal teardown | Preserve |
| manual pane close | Remove stale ownership on reconciliation | Remove stale ownership on reconciliation |
| command returns to its shell | Keep owned as `exited`; close on normal teardown or explicit `stop` | Keep owned as `exited` until explicit `stop` |

Reconciliation uses typed `pane process-info --pane` data to distinguish a foreground command from the pane's interactive shell. After the short launch grace, a reliable returned-shell result is shown as `exited` but remains in the registry. This preserves crash/exit logs, explicit `stop`, duplicate-label protection, and session-lifetime cleanup instead of creating an unmanaged pane. Only a pane absent from the live pane list loses stale ownership. Missing or unreliable process information—including older Herdr behavior—is reported as `unknown` and never authorizes removal. Replacement-session cleanup is attempted from persisted ownership before a potentially transient `pane list` probe.

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

Herdr 0.8.0 can briefly return the typed `agent_pane_busy` code while the fresh shell in a newly split, companion-owned pane is becoming ready. Only that typed failure is retried: at most four non-blocking backoff waits (2.75 seconds total) share one 40-second agent-start deadline, and each attempt receives only the remaining timeout. An abort prevents another start attempt. Exhaustion or any other error still closes exactly the newly created pane and clears its private launch state.

A merge contains only child user/assistant text, excludes thinking/tool payloads/images, and keeps the newest content within a 48KiB transcript budget. Once the parent is idle, it sends one visible custom message that combines the transcript and child-authored follow-up, carries durable `requestId`/`launchId` details, participates in context, bypasses user-input transforms, and triggers the parent turn. Pi 0.84's `sendMessage` wrapper is fire-and-forget, so a dispatch return is never treated as proof of delivery: the parent writes an accepted acknowledgement only after a later scan observes that exact custom message in session evidence.

Recovery is durable and request-deduplicated for **one active Pi owner of a parent session**. The private lock serializes scans and a dispatch lease delays recovery when a crash may have happened around the fire-and-forget call. This is not strict exactly-once delivery across two simultaneously open Pi instances for the same session. A crash or unusually delayed append beyond the lease can cause a request-tagged retry; session evidence deduplicates normal reload recovery, but the residual dispatch/append window cannot be eliminated by ExtensionAPI 0.84.

The child persists the first side-thread Pi session ID in private launch state. `/reload` with that same ID continues normally. `/new`, `/resume`, or `/fork` into another session disables parent-context replay, merge, ack polling/cleanup, and launch-draft submission, with a visible warning; the new session continues independently instead of merging an unrelated transcript into the old parent.

Native replay is only a best-effort prompt-cache optimization. It requires inherited model/thinking, a known parent system prompt with a matching fingerprint, and an exact ordered fingerprint of every active tool's name, description, parameters, and prompt guidelines. Missing first-turn evidence, any override, or any schema mismatch selects a portable flattened snapshot and records the cache-break reason. Later `before_agent_start` handlers and provider-level request rewrites can still alter the eventual payload after companion's check, so native mode does not promise final provider-payload equivalence or a cache hit.

Launch payloads and mailboxes live under the global Pi agent directory in a socket-specific private state root. Directories are `0700`, files are `0600`, writes use atomic rename, and capability/context values never appear in CLI argv. Delivery-lock timeout recovery checks that the recorded owner PID is dead, then re-reads token, inode/device, and mtime immediately before unlink; uncertainty times out rather than deleting a replacement lock. Side-agent names are persisted and resolved through `agent get`, so pane moves do not make an old pane ID look stale. Stale cleanup conservatively preserves launches without reliable agent/pane resolution, with a live/unknown pane, or with an unacknowledged merge.

Accepted completion does not depend on Pi's asynchronous shutdown cleanup. The child re-resolves its current pane by persisted agent name, focuses the exact parent, verifies that the request has a matching acknowledgement while removing the whole private launch directory, and only then closes the exact child pane. Failed resolution, focus, or mailbox cleanup keeps both the pane and recovery evidence. If cleanup succeeds but pane close fails, the warning states that the mailbox is already gone and the pane must be closed manually.

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
- Merge is bound to the exact parent session ID, and the child is bound to its first side-thread session ID. If the parent is unavailable, the request remains pending and diagnosable; if the child switches session, side-thread behavior is disabled.
- After accepted ack, the child resolves its current pane by persisted Herdr agent name, focuses the exact parent, removes private launch state only after confirming a matching request/ack, and only then closes. Resolution, focus, or cleanup failure leaves both state and pane available for recovery; a later close failure requires manual pane close because state has already been removed.
- Normal failure paths remove private payloads and best-effort close only a pane ID explicitly returned by split success/failure. A split failure without an explicit ID reports a possible orphan and deliberately leaves unidentified panes untouched. Hard process/host crashes cannot offer absolute cleanup guarantees.
- POSIX filesystems do not expose a portable unlink-if-inode-matches operation. Lock identity is rechecked immediately before deletion, but an irreducible final check/unlink race remains; conservative timeout is used whenever replacement is observed or ownership is uncertain.
- Herdr 0.7.5+ is the compatibility floor; `process-info` absence degrades to non-destructive `unknown`, and advanced layout operations are intentionally out of scope.

## Development

```bash
pnpm --filter @zhcsyncer/pi-herdr-companion typecheck
pnpm --filter @zhcsyncer/pi-herdr-companion test
pnpm --filter @zhcsyncer/pi-herdr-companion check
npm pack --dry-run ./packages/pi-herdr-companion
```

## License

MIT. The `/btw` product behavior and parts of the private context/mailbox implementation were adapted from MIT-licensed [`pi-herdr-btw@0.3.0`](https://www.npmjs.com/package/pi-herdr-btw) by Oscar Gabriel. Preserved notice and provenance are in [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE) and [`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md).
