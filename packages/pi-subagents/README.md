# @zhcsyncer/pi-subagents

[简体中文](./README.zh-CN.md)

Maintained fork of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents), pinned to `v0.14.3`. Available standalone and embedded in `@zhcsyncer/pi-extensions`.

[Upstream snapshot](./UPSTREAM_README.md) · [Source and upstream differences](./UPSTREAM_SOURCE.md) · [Upstream license](./UPSTREAM_LICENSE)

## Install

Choose one:

```bash
pi install npm:@zhcsyncer/pi-subagents
# Or install the bundle:
pi install npm:@zhcsyncer/pi-extensions
```

Remove any existing `@tintinweb/pi-subagents` installation from Pi settings before loading this fork: both register the same tools and FleetView.

## Core features and upstream differences

- **Delegate work:** `Agent`, `get_subagent_result`, and `steer_subagent`; custom agent roles, model/thinking selection, inherited context, schedules, and concurrency limits.
- **Useful background reports:** notifications include the final report, not just a short preview. Manual Agent-tool background completions reach the parent's next reasoning step; scheduled/RPC completions wait until its current loop finishes.
- **Continue the same agent:** steering a completed or soft-turn-limit agent automatically continues it in the background. Explicit `Agent(resume=...)` supports foreground or background continuation, including eligible saved history.
- **Readable progress:** compact Claude Code-style rows for all three tools, honest queued/working states, readable durations, effective model/effort, separate lifetime usage and current context, and expandable Markdown results.
- **Browse finished work:** ordinary sessions persist by default, nest beneath the parent in Pi's `/resume` for same-directory runs, and remain openable from `/agents` finished history.
- **Worktrees are opt-in:** selected upstream 0.17 session/isolation behavior, but `worktreeIsolation` defaults to `false` here rather than upstream's enabled default.
- **Integrate with other extensions:** protocol-v3 in-process spawn with inline roles, caller-owned completion, route correlation, and concurrency discovery; an importable runtime without automatic UI/tool registration.
- **Keep trusted observers active:** `pinnedExtensions` loads observers even in isolated agents without granting their tools.

The [upstream snapshot](./UPSTREAM_README.md) covers custom agents, schedules, and other baseline features. For delivery, continuation, persistence, configuration locations, and worktree defaults, use this fork's documentation instead.

## Delegate and receive results

Use **foreground** (default) when the result is a prerequisite for your next read, edit, or decision. Use `run_in_background: true` only when you have genuinely disjoint work to do. Do not poll, sleep, or duplicate the subagent's evidence collection while it runs. You still own synthesis and final verification; check high-risk claims rather than repeating the whole investigation.

Background notifications include the **complete final report when it fits within 16 KiB of UTF-8 per emitted message**, including metadata and escaping. Grouped reports share that total budget, not one budget per agent. Oversized reports are explicitly marked as truncated and direct you to `get_subagent_result(agent_id)` for the full result. Add `verbose: true` for the conversation, including tool outputs.

`get_subagent_result` with `wait: true` waits for completion. Cancelling that wait cancels **only the waiter**, not the child or its eventual completion notification. Use FleetView's stop action to stop the child.

Manual Agent-tool background completion (including custom roles that default to background) uses `steer`: while the parent is busy, it arrives after currently issued tools finish and before the next model call; while idle, `triggerTurn: true` starts reasoning. It cannot retract sibling tools already issued in the same turn. Scheduler/RPC completion uses `followUp`: while busy, it waits for the loop to finish; while idle, it also triggers reasoning. Caller-owned completion suppresses this parent nudge. Foreground results return inline without a background nudge.

## Session usage and Glance

`reportUsage` defaults to **on** in this fork (unlike upstream 0.18). Pi **0.81.0 or newer** counts collected child usage in native session totals and Glance:

- Foreground: usage is attached to the completed `Agent` tool result.
- Background: the launch acknowledgement carries no usage; the completed `get_subagent_result` reports it once. A notification alone does not yet update parent totals.
- Repeated retrievals and resumes report only previously unreported lifetime usage, including cache reads and provider-reported cost.

Keep **pi-meter pinned** for live child-session accounting. Meter ignores the parent rollup rather than charging it again; child messages and history imports retain their original session/model attribution. Disable **Report usage** in `/agents → Settings` (or `reportUsage: false`) to opt out of parent totals without disabling the pin.

## Steer, continue, or retry

Use `steer_subagent` with the same agent ID and a message:

| Agent state | What happens |
| --- | --- |
| Running | Appends steering to the current run |
| Queued or initializing | Saves the message for delivery when the child is ready |
| Completed or `steered` (soft turn limit) | Starts a background continuation with the same ID and context, subject to concurrency limits |
| Error, aborted, or stopped | Rejects steering; an explicit resume is required to retry |

For explicit continuation, use `Agent` with `resume: "<agent-id>"` and `prompt: "<follow-up>"`. Resume defaults to **foreground**, even if the earlier run was background. Add `run_in_background: true` to return immediately with queued/running status and use the same automatic completion, wait, and stop lifecycle as a new background run. Background resumes respect the concurrency limit; foreground resumes bypass the background queue, like new foreground runs.

A new Agent call without `resume` starts fresh; it does not inherit the old agent's conversation. Failure and stopped states are never automatically retried. If a continuation fails or is stopped, result retrieval retains the previous completed report under an explicit history label; it is not presented as the failed run's output. Resuming the same ID does not redeliver the previous run's pending completion as a new result.

### Saved versus live-only agents

Ordinary runs persist by default. Set `persist_session: false` in an agent file for a live-only run, or `rememberAgents: false` in `/agents → Settings` for a memory-only default; explicit `persist_session: true` overrides that default. Live-only agents can continue while retained, but not reliably after eviction or restart.

Recovery of saved terminal work requires eligible new-format history on the current parent-session branch and an intact child session. Older history remains viewable but cannot be resumed through these tools without recovery information. Failed/stopped saved runs still require explicit `Agent(resume=...)`.

Missing or corrupt recovery files, an unavailable original working directory (including a cleaned-up worktree), or an unavailable original model cause an explicit error—never a fresh session or substitute model. Recovery uses currently installed extensions and current credentials; it is **not a process/memory snapshot or a sandbox**. In-flight work and queued follow-ups are not durably replayed after an unclean crash; no crash-exactly-once guarantee is provided.

## Inspect progress and settings

Open `/agents` / FleetView and select an agent to see **Prompt → Usage → Steps → Result**. Tool bodies are folded by default; failure and turn-limit outcomes remain explicit.

| Key | Action |
| --- | --- |
| `Esc` / `q` / `Ctrl+C` | Close |
| `↑↓` / PgUp/PgDn | Scroll |
| `Enter` in the conversation view | Steer a running agent |
| `x` `x` | Confirm stop |
| `o` | Expand/fold tool arguments and results |
| `Ctrl+O` in the main transcript | Expand the tool's Markdown result |

Compact lifetime tokens mean `input + output + cache write`; cache reads remain in the full Usage breakdown ([upstream issue #38](https://github.com/tintinweb/pi-subagents/issues/38)). Current context is context-window usage, not a percentage of lifetime tokens. `effort` is the display name for `thinking`. Compact progress shows stable coarse phases rather than streaming paths, commands, or assistant text.

Manage project preferences in `/agents → Settings`:

- **Worktree isolation:** off by default. When disabled, the Agent tool omits worktree options and worktree requests from agent files, schedules, or RPC run in the real checkout. Enable it for `isolation: "off" | "worktree"` in the next Pi session. Once enabled, worktree creation failure is an error, not a checkout fallback.
- **Pinned observers:** only user-owned global configuration can grant names such as `pi-meter`; projects can inherit or clear pins, not add observers. Pinning is **not a sandbox**: handlers still run, so pin only trusted observers. Their tools remain subject to the agent's normal tool policy, including `isolated` / `extensions: false`.
- **Agent description:** use the [example template](./examples/agent-tool-description.md) for custom delegation guidance.

[Configuration and integration reference](../../docs/pi-subagents/configuration-and-integrations.md) · [Delivery and recovery contract](../../docs/pi-subagents/delivery-and-resume.md)

## License

MIT — [LICENSE](./LICENSE) and [UPSTREAM_LICENSE](./UPSTREAM_LICENSE).
