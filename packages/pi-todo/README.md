# pi-todo

[简体中文](./README.zh-CN.md)

A Todo extension for Pi, maintained from `@juicesharp/rpiv-todo`. It registers the `todo` tool, the `/todo` settings/reset command, and a persistent task overlay. It can be installed on its own and is also included in the aggregate `@zhcsyncer/pi-extensions` package.

This fork intentionally does not integrate tool intent. Successful Todo calls render as zero rows in the TUI transcript by default because the persistent widget already shows current state. Press `Ctrl+O` to expand compact call and result summaries; execution errors always remain visible. Tool `content`, mutation checkpoints, and user-reset checkpoints remain in the session for model feedback and branch-aware restoration, while read-only queries use lightweight details that do not duplicate task state.

## Install

Install only the Todo extension:

```bash
pi install npm:@zhcsyncer/pi-todo
```

Or install the complete extension bundle from this repository:

```bash
pi install git:github.com/zhcsyncer/pi-extensions
```

## Workflow and state contract

- Start Todo only when the initial plan has at least two independently valuable milestones. One-milestone work runs directly regardless of risk, duration, importance, or expected tool count. Split only genuinely distinct outcomes; never split a tightly coupled edit-test loop or invent filler to reach the minimum.
- Todo is a bounded, ordered execution focus that helps the agent stay on course across context growth, compaction, resume, and tree navigation. It is not a design document, execution log, dependency graph, or durable audit trail; keep long-lived decisions and evidence in dedicated documents and the transcript.
- The normal lifecycle is `pending → in_progress → completed`. A pending task may move directly to completed when reconciling work already finished, and an active task may return to pending when separate interrupting work is required.
- Create defaults to pending, or pass `status: "in_progress"` to start immediately. `subject` and optional `description` identify the task; there is no separate active-form field.
- Exactly one task may be `in_progress`. The initial batch order is the default serial sequence; `in_progress` is the authoritative current focus when later interrupting work temporarily changes that sequence.
- Start every fresh cycle with one atomic `batch` containing at least two create operations in execution order, with the first task in progress and the rest pending. Never use a top-level create or one-item batch to bootstrap a cycle; top-level create appends a newly discovered milestone to an already active multi-item cycle.
- A cycle may later have only one unfinished or visible task after other tasks finish. That is normal and does not justify adding filler.
- `batch` applies create/update/delete operations in array order and rolls the entire batch back if any operation fails. When separate work interrupts the current milestone, atomically re-queue the current task and create the interrupting task in progress; after it completes, resume the original task.
- When every current task is completed or deleted, begin the next cycle with the required multi-create batch; rollover occurs automatically before that batch. Previous-cycle tasks leave live state and are available only through the transcript/tree. Runtime rejects a top-level create or a one-create batch on an empty or terminal cycle.
- Task IDs stay monotonic across the whole session tree: rollover and user reset preserve `nextId`, and branch replay keeps the session-wide high-water mark, so IDs are not reused.
- Default `list` output contains only pending and in-progress tasks and reports how many completed tasks were hidden. With no status filter, `includeDeleted: true` returns all current live-state statuses; an explicit `status` filter can query completed or deleted directly.

Create an initial list and start the first milestone atomically:

```json
{
  "action": "batch",
  "operations": [
    { "action": "create", "subject": "Research current behavior", "status": "in_progress" },
    { "action": "create", "subject": "Implement changes" },
    { "action": "create", "subject": "Validate results" }
  ]
}
```

Hand off an existing list in operation order:

```json
{
  "action": "batch",
  "operations": [
    { "action": "update", "id": 1, "status": "completed" },
    { "action": "update", "id": 2, "status": "in_progress" }
  ]
}
```

## Visual settings, reset, and JSON configuration

In TUI mode, run `/todo` to configure the user-visible `statusIcons` and `maxWidgetLines` settings or choose **Reset current todos**. Reset shows the number of tasks that will be removed, adds a warning when pending or in-progress work exists, and defaults to cancel. Confirming it writes a branch-scoped checkpoint, clears the widget immediately, and preserves `nextId` so later task IDs are not reused. Other Pi modes reject the command with a clear error instead of opening an unsupported custom UI.

Global configuration lives at:

```text
$PI_CODING_AGENT_DIR/extension-data/pi-todo/config.json
```

Pi's default agent directory makes this `~/.pi/agent/extension-data/pi-todo/config.json`. On first read, an existing `$XDG_CONFIG_HOME/rpiv-todo/config.json` (normally `~/.config/rpiv-todo/config.json`) is migrated atomically. The canonical file always wins; malformed, unreadable, or conflicting legacy files are retained with a warning rather than overwritten or silently removed.

The same visual settings can be edited directly as JSON:

```json
{
  "statusIcons": "ascii",
  "maxWidgetLines": 13
}
```

`maxWidgetLines` limits the widget's actual height, including its heading, task rows, overflow summary, and trailing blank separator. The default remains 13 lines. Finite numeric values are floored and clamped to at least 4; invalid values fall back to 13. JSON accepts any finite integer, while `/todo` offers practical presets and retains a valid custom value already loaded from JSON.

| Preset | Heading | pending | in_progress | completed | Notes |
| --- | --- | --- | --- | --- | --- |
| `ascii` (default) | `[T]` | `[ ]` | `[>]` | `[x]` | Fixed-width ASCII; the most portable option across terminals |
| `unicode` | `≡` | `○` | `◉` | `✓` | Compact standard Unicode glyphs |
| `nerd-font` | `󰝖` | `󰄰` | `󰪞`…`󰪥` | `󰗠` | Requires a Nerd Font; only active task rows animate at 300 ms intervals |

The heading always uses its own static Todo icon. Status glyphs use Pi theme semantics: pending is `dim`, in progress is `accent`, and completed is `success`. Task text further distinguishes state: pending is `muted`, in progress is bold `accent`, and completed is struck-through `dim`. Nerd Font in-progress frames animate at 300 ms intervals and react immediately when the preset changes.

When the widget overflows, admission priority is `in_progress`, then `pending`, then `completed`; tasks keep their original order within each status, and admitted rows render in natural task order. The summary reports hidden pending and completed tasks accurately.

The same JSON file may set `guidance.promptSnippet` and `guidance.promptGuidelines` to override model-facing Todo guidance. These fields intentionally remain JSON-only because they change the model's system prompt and are not visual settings. Invalid icon or guidance values retain the existing fallback behavior.

Legacy V1/V2 session snapshots may still contain retired fields such as `activeForm` or dependency data, and V1 may contain an `action: "clear"` checkpoint. Replay accepts those historical snapshots, keeps only the current task fields, and initializes added V2 state fields when needed. The current model-facing schema exposes neither `clear` nor dependency-graph fields.

## Provenance

- Upstream: [`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)
- Baseline: `v1.20.0` / `060373d9292aeb46aeedc23a6d818a997200a6e5`
- Preserved upstream documentation: [`UPSTREAM_README.md`](./UPSTREAM_README.md)
- Preserved upstream history: [`UPSTREAM_CHANGELOG.md`](./UPSTREAM_CHANGELOG.md)

This package is published independently as `@zhcsyncer/pi-todo`; the root bundle embeds the same implementation.

## Rendering and persistence

- `renderShell: "self"` hides successful nodes by default and provides an auditable expanded summary without duplicating the widget.
- Reducer validation failures throw real Pi tool errors; execution errors are always visible.
- Successful mutations store a V2 `kind: "checkpoint"` envelope containing the bounded live state (`tasks`, monotonic `nextId`, internal `generation`, and `revision`). `list` and `get` store only a small `kind: "query"` envelope and are ignored by replay.
- User-confirmed reset is persisted as a branch-scoped `pi-todo-state` custom checkpoint. V1 full-state tool results remain replay-compatible.
- `session_start`, `session_tree`, and `session_compact` restore the last valid mutation/reset checkpoint on the active branch; unknown or malformed envelopes are skipped.
- Before every agent run with active work, the extension appends a short `Current Todo state` section to that run's system prompt. If Todo changes later in the same run, an ephemeral `Current Todo state update` is added to subsequent model contexts so overflow compact/retry cannot revive the run-start snapshot. Neither form is written as a session entry. They include only active task IDs/statuses/subjects in natural order and the completed count—never descriptions, metadata, deleted tasks, or prior cycles.
- Each extension runtime owns an isolated store, so multiple SDK `AgentSession`s in one Node.js process do not share tasks.
- Raw tool calls and results remain in the session; default hiding affects only the TUI. Todo is bounded live execution state, not an archive; prior cycles remain available through the transcript/tree rather than current `list/get`.

## Development

```bash
pnpm --filter @zhcsyncer/pi-todo check
pi --no-extensions -e ./packages/pi-todo --list-models __pi_todo_check__
```

## License

MIT. See [`LICENSE`](./LICENSE) and [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE).
