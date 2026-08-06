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

- Custom `renderCall` / `renderResult` for **`Agent`**, **`get_subagent_result`**, **`steer_subagent`** using **Claude Code chrome** (upstream README shape):
  - Call: `▸ Type  description` (+ chips only when args explicitly set model/thinking/bg)
  - Running: `⠹ stats` / `⎿ activity`
  - Queued: real `status: "queued"` + `queued…` (never "Running in background" / thinking…)
  - Done: `✓ stats · duration` / `⎿ Done` (Wrapped up / Stopped / Error variants)
  - Expanded (Ctrl+O): same chrome + **Markdown** body — never dump full payload by default (`src/ui/tool-render.ts`)
- Result stats always surface **effective model** (including parent inherit) and **effort** (from `thinking`).
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

### Intentionally unchanged vs upstream

- Tool contracts (names/params), background followUp notifications, FleetView navigation/steer/stop, custom agents, worktrees, schedules, settings, RPC.
- Note: queued `get_subagent_result` copy and failure `isError` flag are model-visible deltas kept for honesty; runtime spawn/steer/resume behavior is otherwise upstream-aligned.
