<div align="center">

# ◌ @zhcsyncer/pi-glance

[简体中文](./README.zh-CN.md)

**A calm, composable input surface for [Pi](https://github.com/earendil-works/pi-mono)**

Replace the default prompt with a rounded multiline editor and an inline glance at Git, cost, Reply speed, context, optional tokens, and model—without hiding statuses published by other extensions.

This package is a maintained fork of [`pi-glance`](https://github.com/LinYS77/pi-glance) 0.5.3. It builds on upstream's input surface with a status-only footer, Follow Pi theme integration, bottom-right context and auto-compaction details, and a switchable, theme-aware Claude-inspired working indicator.

[![npm](https://img.shields.io/npm/v/%40zhcsyncer%2Fpi-glance?style=flat-square&color=blue)](https://www.npmjs.com/package/@zhcsyncer/pi-glance)
[![license](https://img.shields.io/badge/license-MIT-64748b?style=flat-square)](LICENSE)
[![pi](https://img.shields.io/badge/pi-package-7c3aed?style=flat-square)](https://github.com/earendil-works/pi-mono)

</div>

---

## Install

From npm:

```bash
pi install npm:@zhcsyncer/pi-glance
```

For local development from this monorepo:

```bash
pi --no-extensions -e ./packages/pi-glance
```

Then restart Pi or run `/reload` after installing or changing the extension.

To update installed packages/extensions, use `pi update --extensions` or `pi update --all`. `pi update` updates Pi itself by default.

Compatibility: current `@zhcsyncer/pi-glance` releases target Pi packages under `@earendil-works/*`, Pi 0.80.4 or newer, and Node 20 or newer. The 0.80.4 floor is required by the public `agent_settled` lifecycle event used to clean up the working indicator after retries and continuations.

For development/testing:

```bash
pi -e /path/to/pi-glance
```

Local checks and Git diagnostics:

```bash
pnpm test
pnpm test:git
pnpm debug:git
```

## Use

```text
/glance
/diff
```

`/glance` opens a calm settings pane with a real input-surface preview and a compact three-column settings grid. `/diff` hands the terminal to optional [`revdiff`](https://revdiff.com/) for an uncommitted working-tree review; annotations return to Pi's editor for you to confirm or edit, and are never sent automatically.

## What you see


![pi-glance demo](https://raw.githubusercontent.com/LinYS77/pi-glance/main/assets/demo.gif)


| | | |
|---|---|---|
| 🖊️ | **Rounded editor** | Configurable 2 / 3 / 4 min rows and 0 / 1 / 2 top spacing rows, preserving Pi autocomplete, paste, and scrolling |
| 🏷️ | **Project title** | Current folder name, or a safe `~/...` path when enabled |
| 📊 | **Inline status** | Git · cost · Reply speed · context · optional tokens · model — top-right |
| Δ | **Working tree** | Unique changed-file count and tracked `+N −N` stats in the Git status line, or optionally pinned to the bottom-right border |
| ⚙️ | **`/glance` pane** | General settings, segment order, and per-segment detail settings in a calm grid |
| 💤 | **Dim unfocused** | Surface quiets down when you scroll the chat |
| 🎨 | **Themes** | Follows Pi theme tokens by default, with 22 built-in Glance palettes available as an alternative/fallback |
| ✢ | **Working indicator** | Claude-inspired spinner, shimmer, activity, current-cycle output, and elapsed time, with automatic narrow-terminal fitting |

## Notes

- New installs use `/glance` → **General** → `Color source` → `Follow Pi`. Choose `Glance palette` to use the built-in palettes directly. `Light palette` and `Dark palette` also remain the safe fallback when the current Pi theme is unavailable. Both browsers contain all 22 palettes, with the matching tone listed first.
- Icons default to `plain` so pi-glance works with normal terminal fonts.
- Editor top spacing is configurable: open `/glance` → **General** → `Top spacing` and choose `none`, `1 row`, or `2 rows`.
- The focused frame uses the selected Color source border and does not change with thinking level. Bash is the only dynamic exception: `!` uses the source-aware Bash color and shows `Bash`; `!!` shows `Bash · no context`.
- Long input height, internal scrolling, `↑/↓ N more`, autocomplete, and large-paste markers remain Pi-native behavior.
- `nerd` icons are opt-in: open `/glance` → **General** → `Icons` and choose `nerd` for richer symbols.
- Nerd icons need a Nerd Font or Symbols Nerd Font fallback. If icons look like boxes, choose `plain`.
- pi-glance does not auto-detect, install, or bundle terminal fonts.
- Other extensions' `ctx.ui.setStatus()` values remain visible below the editor. Glance permanently omits Pi's two informational footer rows because the input surface already shows those primary facts; there is no setting to restore them.
- New installs keep working-tree counts in the Git status line, for example `main Δ6 +123 −99`. The dirty lamp stays off while those counts are visible. Open `/glance` → **Git** → `Working tree` to choose `status` (default) or `border right`.
- Working-tree counts cover staged, unstaged, conflict, and untracked paths once per unique current path. `+N −N` is the standard tracked working tree versus `HEAD`; binary or failed/timeout statistics are omitted rather than guessed, and untracked file contents are never read by polling.
- Bottom-right details are always active and have no master switch. Turn on `/glance` → **Context** → `Progress bar` to move context text next to a bottom-right bar (the label always includes percent), then choose a standalone `track` or a progress-aware `border` plus `one third` or `remaining` width. Auto-compaction is shown when enabled and can be hidden under **Bottom details**.
- Reply speed is enabled by default and appears between cost and context. It shows output tokens per wall time: `?` means no trusted measurement yet, `~42 tok/s` is a provisional current-run checkpoint from completed turns, and `42 tok/s` is the finalized agent-end measurement.
- Configure `/glance` → **Reply speed** → `Precision`: `auto`, `1 digit`, or `0 digits`. Wall time includes tools, waiting, network, and thinking, so it is not a benchmark. Reply speed uses no notifications or token estimation from text/deltas and adds no command, footer, dashboard, history, or average view.
- The Claude-inspired working indicator is a Glance component, not an official Anthropic component or a pixel-compatibility promise. It uses Pi's public display and lifecycle APIs only; it does not change the Agent, prompts, models, tools, messages, or session behavior and never adds completion notifications or transcript lines.
- `/glance` exposes **Working indicator** directly in the first-level menu, with one `Enabled: on/off` switch. `on` is the complete automatic experience; `off` stops its animation and restores Pi's default working row. Returning from a child column preserves the parent item, and each first-level item remembers its last selected child row.

## Working indicator

**Fork difference:** Working indicator is provided by `@zhcsyncer/pi-glance`; upstream `pi-glance` 0.5.3 does not include it.

While a high-level agent cycle is active, Glance owns Pi's working row and automatically shows a themed ping-pong star, a stable per-cycle verb, current requesting/thinking/tool activity, available thinking effort, output tokens for that cycle, and elapsed time. Parallel tools are tracked independently; retry, compaction retry, and queued continuation keep the same verb, clock, and output total until `agent_settled`.

The animation combines a calm eased star with a high-contrast, grapheme-safe accent shimmer whose center is bold. During tool use the verb stays static instead of competing with the visible tool call.

Elapsed time stays compact and human-readable: `47s`, `3m 08s`, and `1h 07m`. It is dim below one minute, uses normal text from one minute up to five minutes, and uses the theme warning color at five minutes or later. Only the elapsed field gains emphasis—a long cycle can still be healthy and progressing.

Working output has a deliberately different window from the other Glance metrics:

- **Working row — current high-level cycle output.** Completed assistant messages use provider-reported `usage.output`. The current complete partial assistant message—including text, thinking, and assembled tool-call arguments—is conservatively estimated with Pi's public `estimateTokens()`. Streaming bursts are coalesced by the existing 120ms working-row ticker, which estimates only the latest complete partial once per frame; an empty partial stays hidden instead of showing `↓ ~0 tokens`. A value such as `↓ ~42 tokens` contains an estimate; final message usage replaces that estimate and removes `~`, without double counting.
- **Top-border Tokens — current session cumulative usage.** It includes reported assistant usage plus nested LLM tool, compaction, and branch-summary usage.
- **Context — current context-window occupancy.** It comes from Pi's context-usage API rather than either output counter.

Narrow terminals preserve the spinner and main verb first, then activity, cycle tokens, and elapsed time; once elapsed time reaches its warning state, it is retained ahead of cycle tokens. Output is grapheme- and display-width-safe. A separate stall color is used only after responding has already produced a generation delta and then makes no assistant progress for 10 seconds. Requesting, thinking, and tool execution are never marked stalled.

Pi's working row is a global singleton with no owner stack. If multiple working-indicator extensions are enabled, the last writer wins. Turning this feature or Glance off restores Pi's default row; it cannot recover another extension's private previous value. Settling, shutdown, and reload perform the same cleanup.

## Themes and config

pi-glance is not a Pi theme manager: it never enumerates, switches, or installs Pi themes. It only reads the current public Pi theme when `colorSource` is `pi`.

New installs default to:

```json
{
  "workingIndicator": {
    "enabled": true
  },
  "git": {
    "worktreeSummary": "status"
  },
  "colorSource": "pi",
  "theme": {
    "light": "light",
    "dark": "dark"
  }
}
```

`Follow Pi` maps the frame, text, status, warning, error, title, detail, and working-indicator roles to Pi semantic theme tokens and updates during runtime theme switches. The normal frame uses Pi's border token rather than the thinking-level border; Bash alone uses Pi's `bashMode` token.

`Glance palette` uses the selected light/dark built-in pair for the frame, segments, context progress, and working indicator. Bash uses that palette's warning color. The same pair is the fallback if no current Pi theme is available. The 22 built-ins include Light/Dark, Catppuccin, Nord, Tokyo Night, Gruvbox, Solarized, Rosé Pine, One, Kanagawa, Everforest, and High Contrast variants.

Migration is conservative: schema 14 and older above/left placements become `git.worktreeSummary: "status"`; schema 10 and older configs without `colorSource` use `colorSource: "glance"`, preserving their previous appearance. Explicit values are retained. Old string themes still migrate to matching light/dark slots.

## Segment details

`/glance` keeps segment settings small and display-focused:

- **Git** — dirty marker, upstream counts, behind-main `main↓N`, SHA, working-tree counts in the status line or bottom-right border, and polling.
- **Cost** — hide zero cost.
- **Reply speed** — enabled by default; shows unknown `?`, provisional `~`, or finalized output tokens per wall time in the status line. Precision can be `auto`, `1 digit`, or `0 digits`. It sends no notifications, uses no timers, and does not estimate tokens from text or deltas.
- **Context** — percent / tokens text, an optional bottom-right progress bar (text moves next to the bar and always includes percent), plus standalone track or border style and one-third or remaining width.
- **Tokens** — input / output, total, or cache details. Tokens stay off by default.
- **Model** — provider and thinking labels. Model stays last by default.

## Footer composition and bottom details

The custom footer always renders only statuses published by extensions, sorted by status key. Pi's two informational footer rows are not reconstructed and cannot be enabled, avoiding duplicate workspace, usage, context, and model facts.

The input box's bottom-right detail area is always active and has no master switch. It can contain:

- **Working tree** — `status` (default) keeps counts in the Git status line. `border-right` embeds the same responsive summary at the far right of the bottom border. Candidates degrade from `Δ 6 files · +123 −99` to `Δ 6 · +123 −99` to `Δ 6`; conflict counts take priority, while clean state disappears first on narrow terminals. With `border-right` plus context `remaining`, Git stays fixed at the far right while context progress uses the space to its left and grows leftward.
- **Context progress** — turn on `/glance` → **Context** → `Progress bar`. Context text leaves the top status line and follows the bar; the label always includes percent, and `Text` can still add tokens (`percent / tokens`). `Progress style: track` preserves the standalone `╶───────────╴ 23%` renderer. `Progress style: border` uses the input border itself: unused cells stay light `─`, used cells become heavy `━`, and `╼` joins them. `Progress width` chooses whether progress plus labels use `one third` of the inner width or all `remaining` bottom-border space. The percentage keeps normal text color and bottom progress omits the context icon; Nerd Font text modes still use `󰍛`.
- **Context risk** — below 70% the used section has the context color, from 70% to below 85% it uses warning, and at 85% or higher it uses error. The same fixed thresholds style top-line context text and both bottom progress styles. Filled and unused border colors come from the selected Color source; unknown progress is dim.
- **Auto compact** — appears only while Pi auto-compaction is enabled. Plain mode shows highlighted `auto`; Nerd Font mode shows the highlighted `󰁄 auto` marker. It reflects Pi's merged global/project setting, reading project settings only for trusted projects.

On narrow terminals the progress visualization shrinks first, then optional token details drop before percent; context takes priority over the auto-compaction marker at the smallest widths. The relevant config is:

```json
{
  "context": {
    "text": "percent",
    "progress": true,
    "progressStyle": "border",
    "progressWidth": "third"
  },
  "bottomDetails": {
    "showAutoCompact": true
  }
}
```

## Top border priority

The top border can show two kinds of information: the workspace title on the left, and dynamic status on the right (Git, cost, Reply speed, context, optional tokens, and model, depending on what is enabled).

During normal editing, both remain visible when they fit. On narrower terminals the dynamic status gets width first; the workspace title shortens into the remaining space, then disappears if that space is too small. Within the status, the segment order configured in `/glance` is also its priority order: leftmost segments stay first, labels switch to shorter forms as needed, and segments are removed from the right before a single overlong segment is truncated.

Bash labels (`Bash` / `Bash · no context`) and the editor's `↑ N more` scroll indicator are higher-priority interaction cues. They replace the workspace title and reserve the left side first, so the dynamic status uses only the space that remains.

## Workspace title

Open `/glance`, select **General**, and set `Workspace label`:

- `name` — show only the current directory name. This is the default.
- `smart` — show more path context on wider terminals.
- `path` — show a safe `~/...` path when possible.

pi-glance never renders full absolute paths in the title: home paths are shortened to `~/...`, and non-home paths use an ellipsis tail such as `…/work/project`.

## Git status and working-tree review

The Git segment is intentionally quiet:

- Clean repositories show only the branch name.
- Dirty repositories add `*` in plain mode or `●` in Nerd Font mode, unless Working Tree file counts are already visible in the Git status or the bottom-right border.
- Conflicts add `!` in plain mode or `⚠` in Nerd Font mode.
- Ahead/behind counts appear when Git reports an upstream, for example `↑2 ↓1`.
- When the current HEAD is behind the last local `origin/main` snapshot, Glance adds a separately highlighted `main↓N`. This does not change the branch's upstream and stays hidden when the count is 0, `origin/main` is missing, or upstream `↓N` is already showing that same lag.
- Non-Git directories hide the Git segment.

Open `/glance`, select **Git**, move to a value with the arrow keys, and press Enter to configure:

- `Dirty marker` — hide/show the dirty lamp when file counts are not already visible; conflict markers stay visible.
- `Ahead / behind` — hide/show upstream counts.
- `Behind main` — hide/show `main↓N` when this branch is behind `origin/main`.
- `SHA` — `off`, `detached`, or `always`.
- `Working tree` — `status` (default) or `border right`.
- `Polling` — `5s`, `15s` (default), `30s`, or `60s`.

`status` appends unique file and tracked `+N −N` counts to the existing Git segment when the tree is dirty or conflicted, for example `main Δ6 +123 −99`. The dirty lamp stays off while those counts are visible. Clean repositories stay as just the branch name. `border right` moves that same compact summary to the bottom-right border and also hides the dirty lamp from the Git status; conflict markers stay.

Git is collected asynchronously and cached. Session start and cwd changes refresh immediately. Mutating or unknown tool completions use a 250ms trailing debounce, explicitly read-only tools are skipped, `agent_settled` recalibrates, and non-overlapping fallback polling defaults to 15 seconds with safe failure backoff. The 5-second status poll never runs `git fetch`; a separate background `git fetch origin main` may run at session start, when the editor returns to the foreground, or when the shared `origin/main` snapshot is older than about 12 minutes. The `main↓N` count is always compared against the last local `origin/main` already on disk. No recursive filesystem watcher is installed.

`/diff` runs revdiff's default uncommitted review directly in the repository cwd. Pi's TUI is stopped for the terminal handoff and restarted afterward. Exit/cancel/error paths always clean temporary annotations and refresh the summary. If annotations were written, Glance loads them into the editor for confirmation instead of sending them to the Agent. If revdiff is missing, only `/diff` shows the install hint (`brew install umputun/apps/revdiff` or `REVDIFF_BIN`); Glance and the summary remain available. Non-TUI modes decline the terminal handoff safely.

For local development/debugging you can compare pi-glance with Git directly:

```bash
git status --short --branch
pnpm debug:git
```

## Design

- No Pi core patches — public extension APIs only
- No render-time IO — Git is collected asynchronously and cached; Pi settings are sampled during lifecycle refreshes; Glance owns one in-memory working-message timer while Pi animates the installed spinner frames through its public UI API
- pi-glance never replaces Pi's native Header or resource area. Context/Skills/Prompts/Extensions keep Pi's native compact/expanded hierarchy; expanded Extensions stay grouped by project/user/path, with `npm:`/`git:` package sources and local file paths shown by Pi
- Global config at `$PI_CODING_AGENT_DIR/extension-data/pi-glance/config.json` (schema version 15). The previous path is migrated and upgraded automatically; unmappable fields are dropped with a warning, while malformed files are preserved

## License and attribution

MIT. Original `pi-glance` copyright © 2026 linys77. See [UPSTREAM_SOURCE.md](./UPSTREAM_SOURCE.md), [UPSTREAM_LICENSE](./UPSTREAM_LICENSE), and [UPSTREAM_README.md](./UPSTREAM_README.md) for the exact fork source and preserved upstream materials.
