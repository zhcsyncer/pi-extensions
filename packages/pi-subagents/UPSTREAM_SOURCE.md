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
- Steps are one line per tool call; tool results folded by default; **`o`** expands args/results.
- Intermediate assistant chatter omitted from the default path.
- On `error` / `aborted` / `stopped`, Result prefers **`record.error`** (or status label); last assistant text is a demoted footnote.
- `bashExecution` honors **`exitCode` / `cancelled`** → error step (`✗`).
- Pure `messages → brief` helpers: `src/ui/conversation-brief.ts`.

### Main-transcript tool TUI

- Custom `renderCall` / `renderResult` for **`Agent`**, **`get_subagent_result`**, **`steer_subagent`**.
- Collapsed = one-line preview (expand toggle honored); expanded = status header + **Markdown** body (`src/ui/tool-render.ts`).
- Always surface **effective model** (including parent inherit) and **effort** (from `thinking`) on call/result rows.
- Validation / not-found failures carry **error** details; undetailed fallback never assumes `completed` / green ✓.
- `resultBodyText` peels only **recognized status headers** so multi-paragraph errors keep the first line.

### Engineering / packaging

- Package name `@zhcsyncer/pi-subagents`; monorepo path `packages/pi-subagents/`.
- Pre-release version **`0.0.0`** until Changesets cuts the first public version.
- Not registered on the root `@zhcsyncer/pi-extensions` `pi.extensions` list yet — local trial via `pi -e ./packages/pi-subagents/src/index.ts`.
- `agent-runner`: skip null parent `modelRuntime` for stricter Pi `ModelRuntime` typings.

### Intentionally unchanged vs upstream

- Tool contracts, background followUp notifications, FleetView navigation/steer/stop, custom agents, worktrees, schedules, settings, RPC.
