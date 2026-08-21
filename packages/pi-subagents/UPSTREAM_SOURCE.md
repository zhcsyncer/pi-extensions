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

**Human-oriented diff summary** (tables, try steps): package [`README.md`](./README.md) / [`README.zh-CN.md`](./README.zh-CN.md) — section **Differences from upstream**.  
**Full upstream product docs**: [`UPSTREAM_README.md`](./UPSTREAM_README.md).

---

## Local differences (maintenance checklist)

Stable “why” only — implementation detail lives in code/tests.

### Selected upstream 0.17 session/isolation port

- Ordinary top-level subagents persist as normal Pi sessions by default and record the spawning session in `parentSession`, so same-directory runs nest under their parent in `/resume`; `persist_session: false` or `rememberAgents: false` restores memory-only execution.
- `/agents` exposes finished agents from the current parent-session branch. A retained record keeps the live brief ConversationViewer; a disk-only record reopens the persisted child session read-only.
- `isolation` accepts `"off" | "worktree"` with the inert value first. Agent-file `off` is a veto because frontmatter outranks invocation parameters.
- Fork-specific policy: upstream 0.17 defaults `worktreeIsolation` on; this fork defaults it **off**. Disabled repositories remove schema and prose together, and the manager downgrades agent-file/scheduler/RPC worktree requests to the real checkout. Enabled worktree creation remains strict and fails loud.
- `@handle`, nested delegation, agent-file identity changes, and other upstream 0.15–0.17 features are intentionally outside this first port.

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

- Manual Agent-tool background runs, including custom-agent frontmatter that resolves to background, fix `completionDelivery: "steer"` at spawn. Their completion reaches the parent before its next model call instead of waiting behind a long tool loop.
- Scheduled and cross-extension RPC runs omit that field and retain AgentManager's detached `followUp` default. Foreground runs still return inline and suppress completion nudges.
- Smart/group batches currently contain only background Agent-tool calls from one assistant turn, so they are homogeneous and use the first record's delivery policy. Scheduler/RPC do not enter those batches.
- Full/compact tool descriptions, prompt guidelines, the launch envelope, and the shipped example require foreground for prerequisite results, background only for genuinely disjoint work, no repeated evidence collection, and targeted verification after the report.
- `steer` cannot retract sibling tools already issued in the same assistant turn. This fork intentionally adds no origin state machine, path locks, natural-language overlap inference, or telemetry.

### Intentionally unchanged vs upstream

- Tool names, FleetView navigation/steer/stop, custom-agent discovery, schedules, and protocol-v3 RPC contracts. The `isolation` parameter and session defaults are the scoped exceptions documented above.
- Note: queued `get_subagent_result` copy, failure `isError`, completion delivery, and orchestration guidance are model-visible deltas kept for honesty and timely result consumption; spawn/steer/resume behavior is otherwise upstream-aligned.
