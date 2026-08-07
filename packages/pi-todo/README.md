# pi-todo

[简体中文](./README.zh-CN.md)

A Todo extension for Pi, maintained from `@juicesharp/rpiv-todo`. It registers the `todo` tool, the `/todo` visual-settings command, and a persistent task overlay. It can be installed on its own and is also included in the aggregate `@zhcsyncer/pi-extensions` package.

This fork intentionally does not integrate tool intent. Successful Todo calls render as zero rows in the TUI transcript by default because the persistent widget already shows current state. Press `Ctrl+O` to expand compact call and result summaries; execution errors always remain visible. Tool `content` and versioned state `details` remain in the session, preserving model feedback, branch restoration, and reconstruction after reload.

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

- Execute single-step, low-risk work directly. Todos represent independently valuable milestones in multi-stage work.
- The normal lifecycle is `pending → in_progress → completed`. A pending task may move directly to completed when reconciling work already finished, and an active task may return to pending when separate blocker work is required.
- Create defaults to pending, or pass `status: "in_progress"` to start immediately. `subject` and optional `description` identify the task; there is no separate active-form field.
- Exactly one task may be `in_progress`. A task whose dependencies are incomplete cannot start or complete.
- `batch` applies create/update/delete operations in array order and rolls the entire batch back if any operation fails. Complete or re-queue the active task before starting the next one.

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

## Visual settings and JSON configuration

In TUI mode, run `/todo` to configure the user-visible `statusIcons` and `maxWidgetLines` settings. Changes are saved atomically to the canonical config file and applied to the current widget immediately. Other Pi modes reject the command with a clear error instead of opening an unsupported custom UI.

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

Legacy session snapshots may still contain `activeForm`; replay ignores that retired field, and new schemas and snapshots no longer emit it.

## Provenance

- Upstream: [`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)
- Baseline: `v1.20.0` / `060373d9292aeb46aeedc23a6d818a997200a6e5`
- Preserved upstream documentation: [`UPSTREAM_README.md`](./UPSTREAM_README.md)
- Preserved upstream history: [`UPSTREAM_CHANGELOG.md`](./UPSTREAM_CHANGELOG.md)

This package is published independently as `@zhcsyncer/pi-todo`; the root bundle embeds the same implementation.

## Rendering and persistence

- `renderShell: "self"` hides successful nodes by default and provides an auditable expanded summary without duplicating the widget.
- Reducer validation failures throw real Pi tool errors; execution errors are always visible.
- Every tool result stores a schema-versioned `tasks` and `nextId` snapshot in `details`.
- `session_start`, `session_tree`, and `session_compact` restore the last valid Todo snapshot on the active branch.
- Each extension runtime owns an isolated store, so multiple SDK `AgentSession`s in one Node.js process do not share tasks.
- Raw tool calls and results remain in the session; default hiding affects only the TUI.
- Task history remains session state. Only user-editable display and guidance configuration moved to `extension-data/pi-todo/config.json`.

## Development

```bash
pnpm --filter @zhcsyncer/pi-todo check
pi --no-extensions -e ./packages/pi-todo --list-models __pi_todo_check__
```

## License

MIT. See [`LICENSE`](./LICENSE) and [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE).
