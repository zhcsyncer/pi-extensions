# @zhcsyncer/pi-subagents

[简体中文](./README.zh-CN.md)

Maintained fork of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) (`v0.14.3` / `@tintinweb/pi-subagents@0.14.3`).

This package publishes on its own and is also embedded in the aggregate `@zhcsyncer/pi-extensions` bundle.

**Full upstream docs** (features, Agent tool, schedules, settings): [`UPSTREAM_README.md`](./UPSTREAM_README.md)  
**Pin + license trail**: [`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md) · [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE)

---

## Differences from upstream (read this first)

This fork keeps upstream's ordinary **Agent runtime** behavior, while changing how manually launched background completion is delivered so current-task results cannot be starved behind a long parent tool loop. Most other changes improve how progress and tool results are shown in the TUI; the fork also exposes an opt-in in-process spawn contract for orchestrator extensions. It selectively ports upstream 0.17's persisted-session and `isolation: "off"` behavior, with worktrees defaulting **off** in this fork.

| Area | Upstream (`@tintinweb/pi-subagents`) | This fork (`@zhcsyncer/pi-subagents`) |
| --- | --- | --- |
| **Conversation overlay** (FleetView / agent list → Enter) | Full conversation dump: user / assistant / toolResult walls (tool bodies truncated ~500 chars but still large) | **Scheme A brief view**: **Prompt** → **Usage** → **Steps** (one line per tool) → **Result**; tool bodies folded by default |
| Runtime status / metrics | Idle progress falls back to `thinking…`; long runs remain long second counts; compact tokens and context can look like one metric | Honest `working…` fallback with delayed, stable coarse phases; friendly minute/hour durations with only the duration fragment highlighted; compact **lifetime** total is distinct from **current context**, with a full usage breakdown in the overlay |
| Overlay step detail | N/A (everything dumped) | Press **`o`** to expand/fold tool args + results |
| Overlay on agent **error / aborted / stopped / steered** | Last messages still dominate the dump | **Result** prefers `record.error`; `steered` shows turn-limit; header icons match chrome; terminal records settle dangling running steps |
| Overlay **bashExecution** | Shown as command + output dump | One step line; **`exitCode` / `cancelled`** → `✗` (not a false `✓`) |
| **Main transcript** `Agent` / `get_subagent_result` / `steer_subagent` | `Agent` has Claude Code chrome; **`get_subagent_result` has no custom `renderResult`** → Pi dumps full payload | Same **Claude Code chrome** for all three; queued is honest (`queued…`); **Ctrl+O** expands Markdown without dumping by default |
| Tool **model / effort** | Model often omitted when same as parent; thinking only in tags if set | **Result stats** always include effective model (`haiku (inherit)` when inherited) + `effort:`; resume chips come from stored invocation |
| Validation / not-found tool failures | Plain text result (with custom Agent renderer missing details → easy to misread after collapse work) | `error` details + `tool_result` → Pi `isError` (error shell); undetailed success paths never heuristic-red |
| Background completion delivery | Manual Agent-tool, scheduled, and RPC completions all use `followUp`, which can starve current-task results during a long parent tool loop | Manual Agent-tool background completion uses `steer`; scheduled/RPC detached completion remains `followUp`; `triggerTurn: true` is retained |
| Subagent Pi sessions | The pinned 0.14.3 baseline keeps sessions in memory unless `persist_session: true` | Ordinary subagents persist by default, record the parent session, appear nested in `/resume`, and remain openable from `/agents` finished history; `persist_session: false` or `rememberAgents: false` restores memory-only runs |
| Worktree isolation | Upstream 0.17 adds `"off"` / `"worktree"` and a repository switch that defaults on | Same `"off"` / `"worktree"` shape (`off` first), but `worktreeIsolation` defaults **false**; disabled repositories remove schema/prose and downgrade every tool/frontmatter/schedule/RPC worktree request to the real checkout |
| Orchestration guidance | Foreground/background ownership is easy to blur | Prerequisite results must run foreground; background is only for genuinely disjoint work; the parent synthesizes and uses targeted verification without repeating delegated evidence collection |
| Cross-extension orchestration | Named-agent spawn RPC | Protocol v3 adds optional inline role config, caller-owned completion, route correlation, effective route metadata, and max-concurrency discovery |
| **Pinned observer extensions** | No equivalent | `pinnedExtensions` loads named observer extensions in every subagent (including `isolated` / `extensions: false`) without exposing their tools |
| Packaging | Standalone npm package | Standalone `@zhcsyncer/pi-subagents` **and** embedded/registered in root `@zhcsyncer/pi-extensions` |

### What did *not* change

- Tool names: `Agent`, `get_subagent_result`, `steer_subagent`; parameters other than the conditional `isolation` enum
- `triggerTurn: true` completion notifications; scheduled/RPC detached completion still uses `followUp`
- FleetView list navigation, Enter steer, `x` `x` stop, Esc/q close
- Custom agents, schedules, and the existing settings menu structure
- Existing cross-extension spawn behavior when the new protocol-v3 fields are omitted

Upstream remains the source of truth for ordinary Agent behavior — start from [`UPSTREAM_README.md`](./UPSTREAM_README.md).

### Cross-extension spawn protocol v3

“RPC” here is an in-process call between Pi extensions over `pi.events`, not a network service. The existing `subagents:rpc:spawn` request accepts four additional optional fields:

- `inlineAgentConfig`: use the supplied role prompt/tools without named-agent discovery or fallback;
- `completionOwner: "caller"`: keep queue, stop, FleetView, lifecycle events, and history, but suppress the per-agent parent-conversation nudge;
- `correlationId`: echo an orchestrator-owned route key in started/terminal events;
- `graceTurns`: optional wrap-up turns after the soft max-turn steer; omit to keep the global five-turn default.

Caller-owned completion requires `isBackground: true` and a non-empty `correlationId`. `subagents:rpc:ping` returns protocol version `3` plus `maxConcurrent`; correlated terminal events include requested/effective model and thinking, plus `sessionFile` when the inline role enabled session persistence. Omitting all new fields preserves the historical named-agent and notification path.

### Foreground vs background contract

Use foreground when the subagent result is a prerequisite for the parent's next read, edit, or decision. Use background only when the parent has genuinely disjoint work to do. Background completion is delivered automatically; do not poll, sleep, or repeat the delegated grep/find/read evidence collection while waiting.

The parent still owns synthesis, decisions, user-facing reporting, and final verification. After a report arrives, verify only high-risk claims with targeted checks instead of rerunning the full investigation. A `steer` completion can enter context before the parent's next model call, but it cannot retract sibling tools already issued in the same assistant turn.

Delivery policy is fixed at spawn time:

- Manual Agent-tool background runs, including custom agents whose frontmatter resolves to `run_in_background: true`: `steer`
- Scheduled and cross-extension RPC runs: `followUp`
- Foreground runs: result returned inline; no background completion nudge

Dependent packages that need the same execution semantics without activating this extension can import `@zhcsyncer/pi-subagents/runtime`. Importing that subpath alone does not register Agent tools, commands, schedules, widgets, or FleetView; the caller owns construction and disposal.

### Persisted sessions and repository worktrees

Subagents now use `SessionManager.create` by default. The child header records the current main-session file as `parentSession`, so ordinary same-directory runs appear beneath their spawner in Pi's `/resume` and can be opened there with their complete conversation. `/agents` also shows **Finished agents in this session** by name and status: a retained live record uses the existing brief ConversationViewer; after that record is evicted, the same read-only overlay opens the persisted session file. Caller-owned runs use the same archive contract: the external extension path and the side-effect-free embedded runtime both append the finished parent record, while terminal lifecycle data exposes the child session path to the orchestrator.

Set `persist_session: false` on an agent file for a per-agent ephemeral run, or set `rememberAgents: false` in `/agents → Settings` / project config to restore memory-only behavior by default. Explicit `persist_session: true` still overrides that setting.

Worktree creation is a repository capability and defaults **off** in this fork. With `worktreeIsolation: false`, the Agent tool exposes neither the `isolation` parameter nor worktree prose, and a `worktree` request arriving through an agent file, scheduler, or cross-extension RPC silently runs in the real checkout instead. Enable **Worktree isolation** in `/agents → Settings` to expose `isolation: "off" | "worktree"` on the next Pi session (`off` is listed first). Once enabled, an actual worktree creation failure still throws; it never silently falls back.

---

## Install

Standalone:

```bash
pi install npm:@zhcsyncer/pi-subagents
```

Or via the root bundle (registers the same extension):

```bash
pi install npm:@zhcsyncer/pi-extensions
```

If `~/.pi/agent/settings.json` already loads `@tintinweb/pi-subagents`, remove that entry — both packages register `Agent` / FleetView and must not run together.

## Try locally (this monorepo)

```bash
# monorepo root
pnpm install
pi --no-extensions -e ./packages/pi-subagents
# or load the whole root bundle:
pi -e .
```

### Conversation overlay (scheme A)

Open FleetView / agent list, select a subagent, press Enter:

1. **Header** — name / status / highlighted duration / tools / compact **lifetime** tokens and **current ctx** percentage
2. **Prompt** — first meaningful user (dispatch) message
3. **Usage** — lifetime `input` / `output` / `cache read` / `cache write`, optional cost, and current context as a separate metric
4. **Steps** — one line per tool (`✓ read path`, `⠹ bash …`, `✗ grep …`); results folded
5. **Result** — final assistant text, `working…` fallback, or **error** on terminal failure

| Key | Action |
| --- | --- |
| `Esc` / `q` | Close |
| `↑↓` / PgUp/PgDn | Scroll |
| `Enter` | Steer (running) |
| `x` `x` | Arm + confirm stop |
| `o` | Expand/fold step detail (**fork**) |

### Tool TUI (main transcript) — Claude Code chrome

Uses Claude Code Task chrome in the main transcript (unboxed `renderShell: "self"`):

```text
● Explore(Find auth files)  haiku · bg
  ⎿  ⠹ exploring… · ↻3 · 3 tool uses · haiku
  ⎿  Done · ↻8 · 5 tool uses · lifetime 33.8k token · 10 min 13s · haiku
```

| State | What you see |
| --- | --- |
| **Call** | `● Type(description)` (+ dim chips only if call args set `model` / `thinking` / `bg`) |
| **Running** | `⎿` spinner + stable coarse phase (`exploring…`, `editing…`, `running commands…`, or `delegating…`); otherwise `working…` |
| **Completed** | `⎿ Done` · turns · tool uses · lifetime tokens · duration · resolved model (Wrapped up / Stopped / Error variants) |
| **Expanded** (`Ctrl+O`) | Outcome clerk + effort/isolation/cost/transcript/worktree clerks + **Markdown** body |

`effort` is display wording for the existing `thinking` parameter/frontmatter field. Effective **model** (including parent inherit) stays on the collapsed clerk. Spawn config (`effort`, `isolated`, `worktree`, `twin`) and cheap extra signals (`cost`, low context %, transcript path) move to the expanded footer so the collapsed row stays scannable. Context at ≥70% and any compaction count stay on the collapsed clerk.

Compact running surfaces do not stream file paths, commands, or assistant body text. Fast and unknown work stays `working…`; a known coarse phase appears only after about 0.8 seconds and then remains visible for at least 1.5 seconds to avoid flicker. Exact per-tool steps remain available in the conversation overlay.

The compact **lifetime** token figure deliberately keeps its existing `input + output + cache write` meaning; `cache read` is retained and shown in the Usage breakdown but is not silently added back into that total ([upstream issue #38](https://github.com/tintinweb/pi-subagents/issues/38)). **Current ctx** is current context-window utilization, not a percentage of the lifetime total. Durations remain seconds below one minute, then switch to readable minute/hour forms such as `10 min 13s` and `1 hr 2 min 3s`.

## Configuration storage

Operational settings now use the extension-data layout:

- Global defaults: `$PI_CODING_AGENT_DIR/extension-data/pi-subagents/config.json`
- Project overrides: `<cwd>/<CONFIG_DIR_NAME>/extension-data/pi-subagents/config.json` (normally `<cwd>/.pi/extension-data/pi-subagents/config.json`)

Project fields override global fields. `/agents` → Settings still writes only the project file; the global file remains hand-edited. The optional custom Agent tool description uses `agent-tool-description.md` beside the corresponding global or project `config.json`, with project content taking precedence. Use `{{isolationGuideline}}` instead of hardcoding worktree guidance so a disabled repository removes the prose together with the schema. Relevant defaults are `rememberAgents: true` and `worktreeIsolation: false`; schema/prose changes from the worktree switch apply on the next Pi session, while runtime downgrade applies immediately.

The former global/project `subagents.json` and `agent-tool-description.md` locations are one-time migration inputs. Migration uses an atomic same-directory rename and semantic re-read before deleting a legacy file. Canonical files always win; malformed, unreadable, or conflicting legacy files remain in place with a de-duplicated warning.

This relocation covers only pi-subagents' operational settings and tool-description override. Custom agents, Pi/native skills and `settings.json`, memory, schedules, session persistence, worktrees, and `.output` transcripts remain in their existing resource or runtime locations. Provider credentials remain in Pi's `auth.json`.

### Pinned extensions

Observer extensions listed in `pinnedExtensions` load in **every** subagent session — including `isolated: true` and `extensions: false`. Pinning never exposes that extension's tools to the subagent LLM; tool visibility still follows the agent's own `extensions:` / `ext:` / `isolated` config.

Set it in the global or project `config.json`, or via `/agents` → Settings → Pinned extensions (comma-separated names; empty clears). A project file with `"pinnedExtensions": []` clears the global pin.

Names match case-insensitively against the extension directory/file and the unscoped pi package short name (`@zhcsyncer/pi-meter` → `pi-meter`). An unused pin in a project that does not have that extension installed is skipped silently.

**Pinning is not a sandbox.** Pinned extension handlers still run (`message_end`, `before_agent_start`, …) and can affect the subagent. Only pin extensions you trust to be pure observers, such as pi-meter.

---

## Package scripts

```bash
pnpm --filter @zhcsyncer/pi-subagents check
pnpm --filter @zhcsyncer/pi-subagents test
pnpm --filter @zhcsyncer/pi-subagents typecheck
```

## License

MIT — [LICENSE](./LICENSE) and upstream [UPSTREAM_LICENSE](./UPSTREAM_LICENSE).
