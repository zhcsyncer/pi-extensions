# @zhcsyncer/pi-herdr-companion

[简体中文](./README.zh-CN.md)

A standalone Pi extension for using Pi inside [Herdr](https://herdr.dev). It adds visible long-running process panes, temporary `/btw` side threads, configurable blocked-state reporting, a settings UI, and `/herdr-worktree cleanup` for the current linked worktree.

The extension stays silent when Pi is outside Herdr or Herdr cannot identify the calling pane.

## Sources

`/btw` product behavior is adapted from MIT-licensed [`pi-herdr-btw`](https://www.npmjs.com/package/pi-herdr-btw) 0.3.0. Managed processes, blocked reporting, and `/herdr-config` are original to this package.

## Features

- `herdr_process` starts, lists, inspects, and stops owned long-running commands in visible Herdr panes.
- A below-editor process list in Pi TUI: `→` activates it, `↑` / `↓` select, `s` stops after confirm, `Esc` returns to the editor.
- `/btw` opens a temporary side conversation. Nothing returns to the parent until you merge.
- Configured tools and extension events can show as blocked in Herdr.
- `/herdr-config` edits runtime guidance, process defaults, and blocked rules.
- `/herdr-worktree cleanup` removes the current linked Herdr worktree. By default it also deletes the local branch; `--keep-branch` keeps the branch. Remote branches are left untouched.

## Install

Needs Node.js 22.19+, Pi 0.84+, and Herdr 0.7.5+ (developed against 0.8.0). Also install Herdr's Pi integration:

```bash
herdr integration install pi
```

Standalone:

```bash
pi install npm:@zhcsyncer/pi-herdr-companion
```

From a checkout:

```bash
pi install /absolute/path/to/pi-extensions/packages/pi-herdr-companion
```

`@zhcsyncer/pi-extensions` embeds these sources for release consistency but does **not** enable the companion. Install it separately.

`herdr_process` and blocked reporting work in TUI, RPC, JSON, and print modes. `/btw`, `/herdr-config`, and `/herdr-worktree` need Pi TUI.

## Processes

Use `herdr_process` for dev servers, previews, and watchers:

```json
{"action":"start","label":"dev","command":"pnpm dev","readyMatch":"Local:","lifetime":"session"}
{"action":"list"}
{"action":"logs","target":"dev","lines":300}
{"action":"stop","target":"dev"}
```

`stop` only closes panes this extension created. Defaults are a downward `0.35` split, Pi's current working directory, a 60-second readiness wait, and `lifetime: "session"`. `/btw` uses the same split direction.

On POSIX, `shell: "bash"` is the default so Fish or another interactive pane shell does not rewrite the command. Use `shell: "pane"` only when the command must use that shell. Windows defaults to `pane`.

`session` panes close when this Pi session ends (`quit`, `/new`, `/resume`, `/fork`). `persistent` panes stay until you stop them. `/reload` and `/tree` keep both. If a command has already returned to the shell, logs stay until teardown or `stop`.

The widget has no Logs action; use `herdr_process logs` so the model can read output without changing focus. Stopping a pane that contains an agent session also closes that session.

## `/btw`

Parent:

```text
/btw
/btw <question>
/btw ask <question>
/btw merge
/btw help
```

Child:

```text
/btw merge <parent follow-up prompt>
/btw merge
/btw help
```

The child is a separate visible Pi in the same working directory. It inherits the parent's model and thinking level, and uses Pi's normal default tools. A question is sent only after the child is ready; bare `/btw` opens an empty child.

The child is **temporary and is not saved as a Pi session**. Closing it before merge loses the unmerged conversation. Merge sends recent user/assistant text to the exact parent session and drops tool calls, thinking, and images. If the parent is closed or busy, reopen that same parent session and run `/btw merge` again.

Do not load another extension that registers `/btw`. `/new`, `/resume`, or `/fork` inside the child disconnects merge; `/reload` does not.

## Blocked reporting

While a configured tool is running, or while a configured extension event payload is `{ active: true }`, Herdr can show a blocked label. `{ active: false }` clears an event. The default tracks `ask_user_question` as `question`.

## `/herdr-worktree`

Run this in the finished feature session that owns the linked worktree:

```text
/herdr-worktree cleanup
/herdr-worktree cleanup --keep-branch
```

Default: detach the current linked worktree, delete the local branch, then remove the Herdr worktree. `--keep-branch` only removes the worktree. The command refuses `main` / `master`, the primary checkout, and a dirty tree. It asks once before changing anything. Remote branches are never deleted.

## Settings

```text
/herdr-config
/herdr-config reset
```

`/herdr-config` edits a draft. **Save and close** writes it; **Discard changes** closes without saving; **Reset draft** replaces the draft with package defaults but does not write until you save. `/herdr-config reset` immediately restores the saved file to defaults.

```json
{
  "runtime": {
    "injectSystemPrompt": true
  },
  "process": {
    "defaultDirection": "down",
    "defaultRatio": 0.35,
    "readyTimeoutMs": 60000,
    "defaultLifetime": "session",
    "defaultShell": "bash"
  },
  "blocked": {
    "events": [],
    "tools": [
      { "name": "ask_user_question", "label": "question" }
    ]
  }
}
```

Windows uses `"defaultShell": "pane"`. Turning off `injectSystemPrompt` only stops the extra Herdr guidance; the tools stay available. In the blocked-rule editors, write one `exact_name = Herdr label` line.

## License

MIT. `/btw` behavior is adapted from MIT-licensed [`pi-herdr-btw@0.3.0`](https://www.npmjs.com/package/pi-herdr-btw) by Oscar Gabriel. Notices are in [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE) and [`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md).
