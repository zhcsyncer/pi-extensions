# Upstream source

This package was forked from `@tintinweb/pi-subagents` **0.14.3**.

| | |
| --- | --- |
| Repository | https://github.com/tintinweb/pi-subagents |
| Tag | `v0.14.3` |
| Commit | `c10b1836256e760da75296ccd4e57a77ada1325e` |
| npm | `@tintinweb/pi-subagents@0.14.3` |
| License | MIT |

Production source and upstream tests were copied from that tag before local modifications. The install under `~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents` matched the GitHub tag and was used as the version pin.

**User-facing features and differences**: package [`README.md`](./README.md) / [`README.zh-CN.md`](./README.zh-CN.md).

**Unmodified upstream snapshot**: [`UPSTREAM_README.md`](./UPSTREAM_README.md); fork delivery/resume, persistence, configuration, and worktree behavior supersede that baseline.

**Maintainer contracts**: [delivery and resume](../../docs/pi-subagents/delivery-and-resume.md) · [configuration and integrations](../../docs/pi-subagents/configuration-and-integrations.md).

---

## Local differences (maintenance checklist)

Stable “why” only — implementation detail lives in code/tests.

### Selected upstream 0.17 session/isolation port

- Ordinary top-level subagents persist as normal Pi sessions by default and record the spawning session in `parentSession`, so same-directory runs nest under their parent in `/resume`; `persist_session: false` or `rememberAgents: false` restores memory-only execution.
- `/agents` exposes finished agents from the current parent-session branch. A retained record keeps the live brief ConversationViewer; a disk-only record reopens the persisted child session read-only. Viewing history is separate from runnable recovery: this fork additionally supports terminal recovery through Agent/steer only with a valid new-format recovery recipe.
- `isolation` accepts `"off" | "worktree"` with the inert value first. Agent-file `off` is a veto because frontmatter outranks invocation parameters.
- Fork-specific policy: upstream 0.17 defaults `worktreeIsolation` on; this fork defaults it **off**. Disabled repositories remove schema and prose together, and the manager downgrades agent-file/scheduler/RPC worktree requests to the real checkout. Enabled worktree creation remains strict and fails loud.
- `@handle`, nested delegation, agent-file identity changes, and other upstream 0.15–0.17 features are intentionally outside this first port.

### Selected upstream 0.18 fixes and native usage reporting

The pin remains **0.14.3**, plus the selected 0.17 port above. Compared against [v0.18.0–v0.18.2 changelog](https://github.com/tintinweb/pi-subagents/blob/v0.18.2/CHANGELOG.md) and corresponding source:

- `reportUsage` follows Pi's `toolResult.usage` accounting (requires Pi >=0.81.0), including cache reads and provider cost. This fork intentionally defaults **on**, unlike upstream's off default, and settles per-agent unreported lifetime usage on foreground Agent results or completed get_subagent_result results, rather than draining a global pool onto the next arbitrary subagent tool call.
- Pi native stats/Glance receive the parent rollup. Pinned pi-meter observers remain the authoritative child-message ledger; meter filters the duplicate parent rollup in live capture and imports instead of listening to lump-sum completion events. [Accounting boundary](../../docs/pi-subagents/pinned-extensions.md).
- RPC explicit models (strings and Model objects) receive the same scopeModels guard as tool-supplied choices; trusted role/parent routes retain their policy.
- ConversationViewer accepts Ctrl+C. Model and thinking displays read the constructed child session, including SDK defaults/clamping and resumed contexts.
- The 0.16 background-resume fix is covered by this fork's unified execution lifecycle below.
- **Not ported:** 0.18 backgroundByDefault, increased default concurrency, 0.19 Workflow, or `@handle` delegation.

### ConversationViewer (scheme A)

- Default overlay is **Prompt · Steps · Result**, not a full message dump.
- Steps are one line per tool call; tool results folded by default; **`o`** expands args/results (expanded bodies hard-capped).
- Intermediate assistant chatter omitted from the default path.
- On `error` / `aborted` / `stopped`, Result prefers **`record.error`** (or status label); last assistant text is a demoted footnote.
- On `steered` (turn-limit wrap-up), Result shows **Wrapped up (turn limit)** — not silent Done.
- Header icons align with tool chrome: running ● / queued ○ / completed ✓ / steered warning ✓ / error·aborted ✗ / stopped ■.
- Terminal records settle dangling `running` steps (unmatched toolCall) so spinners do not survive stop/error.
- `bashExecution` honors **`exitCode` / `cancelled`** → error step (`✗`).
- `inherit_context` prompts keep the **tail** when truncating (dispatch task lives after parent context).
- Pure `messages → brief` helpers: `src/ui/conversation-brief.ts`.

### Main-transcript tool TUI

- Custom `renderCall` / `renderResult` / `renderShell: "self"` for **`Agent`**, **`get_subagent_result`**, **`steer_subagent`** using **Claude Code Task chrome**:
  - Call: `● Type(description)` (+ chips only when args explicitly set model/thinking/bg); marker color follows row state
  - Running: single `⎿ ⠹ activity · outcome chips` (never "Running in background" / thinking… for queued)
  - Queued: real `status: "queued"` + `queued…`
  - Done: single `⎿ Done · turns · tool uses · lifetime tokens · duration · model` (Wrapped up / Stopped / Error variants)
  - Expanded (Ctrl+O): outcome clerk + effort/isolation/cost/transcript/worktree clerks + **Markdown** body — never dump full payload by default (`src/ui/tool-render.ts`)
- Collapsed clerk always surfaces **effective model** (including parent inherit). `effort` and isolation tags move to the expanded footer.
- Widget last line shows the **current tool step** (e.g. `reading src/a.ts`) from `tool_execution_start` args, not only bare `thinking…` when tools are in flight.
- `AgentInvocation.modelInherited` is persisted on the record so `get_subagent_result` restores the same `model (inherit)` chip as the original Agent tool row.
- Status bar (`setStatus("subagents")`) is **auto**: cleared while the above-editor widget is on; compact `N running` text only when `widgetMode: off`.
- Resume details come from the **stored invocation** (old session model/effort) — not the current parent tool args.
- Validation / not-found failures carry **error** details; a `tool_result` hook maps `details.status` ∈ {error,aborted,stopped} → Pi `isError` so the default shell uses error background (not green success).
- Undetailed fallback: explicit `isError=false` never heuristic-reds; free-word scans of user text removed.
- `resultBodyText` peels only **strict** status headers (`Type: … | Status: …`); does not drop unknown-agent notes or agent-authored `Agent:/Type:` reports.

### Engineering / packaging

- Package name `@zhcsyncer/pi-subagents`; monorepo path `packages/pi-subagents/`.
- Publishes standalone **and** is embedded/registered on the root `@zhcsyncer/pi-extensions` `pi.extensions` list (`./packages/pi-subagents/src/index.ts`).
- Root tarball carries subagents sources plus runtime deps (`@sinclair/typebox`, `croner`, `nanoid`).
- `agent-runner`: skip null parent `modelRuntime` for stricter Pi `ModelRuntime` typings.

### Background completion delivery and orchestration contract

- Completion messages carry the full final report within a **16 KiB UTF-8 total budget per emitted message**, including metadata, wrapping, and escaping. Group reports share one total budget, not one per member. Truncation is explicitly labeled with `get_subagent_result(agent_id)` as the full-result path; `verbose: true` includes conversation and tool outputs.
- Reports belong in model-visible `content`. `details` / TUI previews and `appendEntry` archive records do not enter LLM context and cannot substitute for delivery.
- Manual Agent-tool background runs, including custom-agent frontmatter defaults, use `steer`: while busy, after currently issued tools finish and before the parent's next model call; while idle, `triggerTurn: true` starts reasoning. It cannot retract sibling tools already issued in the same turn.
- Scheduler/RPC detached completion retains `followUp`: wait until a busy parent's loop finishes, or trigger reasoning when idle. Foreground returns inline; caller-owned completion suppresses the parent nudge while preserving lifecycle/history.
- Duplicate suppression is per run generation. A resume fences held/grouped completions from the previous generation rather than redelivering them or suppressing the new run.
- Cancelling `get_subagent_result(wait: true)` cancels only the waiter, not the child, result, or eventual completion notification.
- Foreground remains required for prerequisite results; background is only for genuinely disjoint work. The parent synthesizes and verifies high-risk claims without repeating delegated evidence collection. No path locks, natural-language overlap inference, or crash-exactly-once guarantee is added.

### Unified steering and terminal recovery

- `steer_subagent` appends steering while running and saves pending messages while queued/initializing. Completed or soft-limit `steered` agents automatically continue in the background with the same ID/context when steered, subject to concurrency limits.
- Error/aborted/stopped agents reject steering. Retrying requires explicit `Agent(resume=id, prompt=...)`; failure or stop never causes an automatic retry.
- Explicit Agent resume defaults foreground, independently of the previous mode. `run_in_background: true` returns queued/running immediately and reuses normal background completion/wait/stop semantics and concurrency admission.
- Live-only sessions can continue while retained, with no guarantee after eviction/restart. Disk recovery requires a valid terminal archive on the current parent-session branch, the child JSONL, and a supported versioned recipe preserving original rendered system prompt, tool policy, cwd, model, thinking, and limits. Old archives without a recipe remain viewable, not runnable.
- Recovery reloads installed extensions and current credentials: it is neither a process/memory snapshot nor a sandbox. Missing/corrupt recovery files, unavailable original cwd (including cleaned worktrees), or unavailable original model cause explicit errors; never silently start fresh, substitute a model, or move to another checkout. Persisted failed/stopped terminal records still require explicit resume.
- A parent active-run tombstone invalidates the prior completed recovery point when continuation is admitted (even while queued), preventing stale archive recovery after a crash. In-flight work and queued follow-ups are not durable/replayed; this is terminal recovery, not crash replay.

### Preserved baseline and fork-specific scope

- Tool names, FleetView navigation/stop, custom-agent discovery, and schedules retain the baseline interface. Session defaults, conditional isolation, completion delivery, and steer/resume lifecycle are explicit fork deltas—not claims of unchanged upstream behavior.
- Protocol-v3 inline roles, caller-owned completion, correlation, and the side-effect-free runtime are existing fork capabilities retained by this change; omitting the optional fields preserves named-agent RPC behavior.
