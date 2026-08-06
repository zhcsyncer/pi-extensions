# @zhcsyncer/pi-subagents

Maintained fork of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) (`v0.14.3` / `@tintinweb/pi-subagents@0.14.3`).

> Chinese: [README.zh-CN.md](./README.zh-CN.md)

**Full upstream docs** (features, Agent tool, schedules, settings): [`UPSTREAM_README.md`](./UPSTREAM_README.md)  
**Pin + license trail**: [`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md) · [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE)

---

## Differences from upstream (read this first)

This fork keeps upstream **runtime** behavior (spawn, steer, resume, FleetView wiring, notifications, schedules). The changes are almost entirely **how progress and tool results are shown** in the TUI — so you can scan subagent work without drowning in dumps.

| Area | Upstream (`@tintinweb/pi-subagents`) | This fork (`@zhcsyncer/pi-subagents`) |
| --- | --- | --- |
| **Conversation overlay** (FleetView / agent list → Enter) | Full conversation dump: user / assistant / toolResult walls (tool bodies truncated ~500 chars but still large) | **Scheme A brief view**: **Prompt** → **Steps** (one line per tool) → **Result**; tool bodies folded by default |
| Overlay step detail | N/A (everything dumped) | Press **`o`** to expand/fold tool args + results |
| Overlay on agent **error / aborted / stopped** | Last messages still dominate the dump | **Result** prefers `record.error` (or stopped/aborted label); mid-run assistant text is demoted to a dim footnote |
| Overlay **bashExecution** | Shown as command + output dump | One step line; **`exitCode` / `cancelled`** → `✗` (not a false `✓`) |
| **Main transcript** `Agent` / `get_subagent_result` / `steer_subagent` | `Agent` has Claude Code chrome; **`get_subagent_result` has no custom `renderResult`** → Pi dumps full payload | Same **Claude Code chrome** for all three tools: `▸ Type  desc` / `✓ stats` + `⎿ Done` (running: `⠹` + `⎿ activity`); **Ctrl+O** expands Markdown body without dumping by default |
| Tool **model / effort** | Model often omitted when same as parent; thinking only in tags if set | **Result stats** always include effective model (`haiku (inherit)` when inherited) + `effort:` from `thinking`; call line only adds chips when args explicitly set model/thinking/bg |
| Validation / not-found tool failures | Plain text result (with custom Agent renderer missing details → easy to misread after collapse work) | `error` details (or undetailed fallback that **never** paints success `✓`) |
| Packaging | Standalone npm package | Workspace package `@zhcsyncer/pi-subagents` at **`0.0.0`** until Changesets cuts the first release; **not** registered in the root `@zhcsyncer/pi-extensions` bundle yet — load with `-e` (below) |

### What did *not* change

- Tool names and contracts: `Agent`, `get_subagent_result`, `steer_subagent`
- Background completion **followUp** notifications (`triggerTurn`)
- FleetView list navigation, Enter steer, `x` `x` stop, Esc/q close
- Custom agents, worktrees, schedules, settings menus, RPC

Upstream remains the source of truth for those behaviors — start from [`UPSTREAM_README.md`](./UPSTREAM_README.md).

---

## Try locally (this monorepo)

Do **not** change global `~/.pi/agent/settings.json` unless you intend to replace `@tintinweb/pi-subagents` permanently.

```bash
# monorepo root
pnpm install
pi -e ./packages/pi-subagents/src/index.ts
```

If settings already load another `pi-subagents`, temporarily remove that entry for the trial session so only this fork registers the tools and UI.

### Conversation overlay (scheme A)

Open FleetView / agent list, select a subagent, press Enter:

1. **Header** — name / status / duration / tools / tokens (upstream)
2. **Prompt** — first meaningful user (dispatch) message
3. **Steps** — one line per tool (`✓ read path`, `⠹ bash …`, `✗ grep …`); results folded
4. **Result** — final assistant text, running indicator, or **error** on terminal failure

| Key | Action |
| --- | --- |
| `Esc` / `q` | Close |
| `↑↓` / PgUp/PgDn | Scroll |
| `Enter` | Steer (running) |
| `x` `x` | Arm + confirm stop |
| `o` | Expand/fold step detail (**fork**) |

### Tool TUI (main transcript) — Claude Code chrome

Matches upstream’s documented shape ([UPSTREAM_README](./UPSTREAM_README.md) “Individual agent results”):

```text
▸ Explore  Find auth files
⠹ haiku · effort: high · ↻3 · 3 tool uses · 12.4k token
  ⎿  searching…
✓ haiku · effort: high · ↻8 · 5 tool uses · 33.8k token · 12.3s
  ⎿  Done
```

| State | What you see |
| --- | --- |
| **Call** | `▸ Type  description` (+ dim chips only if call args set `model` / `thinking` / `bg`) |
| **Running** | `⠹` + stats / `⎿` activity |
| **Completed** | `✓` + stats · duration / `⎿ Done` (or Wrapped up / Stopped / Error) |
| **Expanded** (`Ctrl+O`) | Same chrome + **Markdown** body (no default dump) |

`effort` is display wording for the existing `thinking` parameter/frontmatter field. Effective **model** (including parent inherit) is always on the **result** stats line when known.

---

## Package scripts

```bash
pnpm --filter @zhcsyncer/pi-subagents check
pnpm --filter @zhcsyncer/pi-subagents test
pnpm --filter @zhcsyncer/pi-subagents typecheck
```

## License

MIT — [LICENSE](./LICENSE) and upstream [UPSTREAM_LICENSE](./UPSTREAM_LICENSE).
