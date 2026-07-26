<div align="center">

# ◌ @zhcsyncer/pi-glance

[简体中文](./README.zh-CN.md)

**A calm, composable input surface for [Pi](https://github.com/earendil-works/pi-mono)**

Replace the default prompt with a rounded multiline editor and an inline glance at Git, cost, Reply speed, context, optional tokens, and model—without hiding statuses published by other extensions.

This package is a maintained fork of [`pi-glance`](https://github.com/LinYS77/pi-glance) 0.5.3. It preserves upstream behavior while adding a status-only footer, a bottom-right context progress mode, and a highlighted auto-compaction indicator.

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

Compatibility: current `@zhcsyncer/pi-glance` releases target Pi packages under `@earendil-works/*`, Pi 0.80 or newer, and Node 20 or newer.

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
```

That's the only command — opens a calm settings pane with a real input-surface preview and a compact three-column settings grid.

## What you see


![pi-glance demo](https://raw.githubusercontent.com/LinYS77/pi-glance/main/assets/demo.gif)


| | | |
|---|---|---|
| ◌ | **Startup header** | Responsive Pi logo plus one randomly selected tip; Pi's own resource summary stays below it |
| 🖊️ | **Rounded editor** | Configurable 2 / 3 / 4 min rows and 0 / 1 / 2 top spacing rows, preserving Pi autocomplete, paste, and scrolling |
| 🏷️ | **Project title** | Current folder name, or a safe `~/...` path when enabled |
| 📊 | **Inline status** | Git · cost · Reply speed · context · optional tokens · model — top-right |
| ⚙️ | **`/glance` pane** | General settings, segment order, and per-segment detail settings in a calm grid |
| 💤 | **Dim unfocused** | Surface quiets down when you scroll the chat |
| 🎨 | **Themes** | Follows Pi theme tokens by default, with 22 built-in Glance palettes available as an alternative/fallback |

## Notes

- New installs use `/glance` → **General** → `Color source` → `Follow Pi`. Choose `Glance palette` to use the built-in palettes directly. `Light palette` and `Dark palette` also remain the safe fallback when the current Pi theme is unavailable. Both browsers contain all 22 palettes, with the matching tone listed first.
- Icons default to `plain` so pi-glance works with normal terminal fonts.
- The optional Startup Header is enabled on new installs and uses a static responsive Claude-style box: Pi version, block logo, `Pi · Glance`, current model/thinking/cwd, one session-stable Tip, and `/glance`, `/model`, `/settings`, `/hotkeys`. Existing schema-10 configs keep Pi's built-in Header until `Startup header` is enabled. Pi quiet startup always wins.
- Editor top spacing is configurable: open `/glance` → **General** → `Top spacing` and choose `none`, `1 row`, or `2 rows`.
- The focused frame uses the selected Color source border and does not change with thinking level. Bash is the only dynamic exception: `!` uses the source-aware Bash color and shows `Bash`; `!!` shows `Bash · no context`.
- Long input height, internal scrolling, `↑/↓ N more`, autocomplete, and large-paste markers remain Pi-native behavior.
- `nerd` icons are opt-in: open `/glance` → **General** → `Icons` and choose `nerd` for richer symbols.
- Nerd icons need a Nerd Font or Symbols Nerd Font fallback. If icons look like boxes, choose `plain`.
- pi-glance does not auto-detect, install, or bundle terminal fonts.
- Other extensions' `ctx.ui.setStatus()` values remain visible below the editor. Glance permanently omits Pi's two informational footer rows because the input surface already shows those primary facts; there is no setting to restore them.
- Bottom-right details are always active and have no master switch. Choose `/glance` → **Context** → `Display` → `progress bar` to move context there, then choose a standalone `track` or a progress-aware `border` plus `one third` or `remaining` width. Auto-compaction is shown when enabled and can be hidden under **Bottom details**.
- Reply speed is enabled by default and appears between cost and context. It shows output tokens per wall time: `?` means no trusted measurement yet, `~42 tok/s` is a provisional current-run checkpoint from completed turns, and `42 tok/s` is the finalized agent-end measurement.
- Configure `/glance` → **Reply speed** → `Precision`: `auto`, `1 digit`, or `0 digits`. Wall time includes tools, waiting, network, and thinking, so it is not a benchmark. Reply speed uses no notifications, no timers/tickers, no token estimation from text/deltas, and adds no command, footer, dashboard, history, or average view.

## Themes and config

pi-glance is not a Pi theme manager: it never enumerates, switches, or installs Pi themes. It only reads the current public Pi theme when `colorSource` is `pi`.

New installs default to:

```json
{
  "colorSource": "pi",
  "startupHeader": true,
  "theme": {
    "light": "light",
    "dark": "dark"
  }
}
```

`Follow Pi` maps the Header, frame, text, status, warning, error, title, and detail roles to Pi semantic theme tokens and updates during runtime theme switches. The normal frame uses Pi's border token rather than the thinking-level border; Bash alone uses Pi's `bashMode` token.

`Glance palette` uses the selected light/dark built-in pair for the Header, frame, segments, and context progress. Bash uses that palette's warning color. The same pair is the fallback if no current Pi theme is available. The 22 built-ins include Light/Dark, Catppuccin, Nord, Tokyo Night, Gruvbox, Solarized, Rosé Pine, One, Kanagawa, Everforest, and High Contrast variants.

Migration is conservative: schema 10 and older configs without the new fields use `colorSource: "glance"` and `startupHeader: false`, preserving their previous appearance and Pi's built-in Header. Explicit values are retained. Old string themes still migrate to matching light/dark slots.

## Segment details

`/glance` keeps segment settings small and display-focused:

- **Git** — dirty marker, upstream counts, SHA, and polling.
- **Cost** — hide zero cost.
- **Reply speed** — enabled by default; shows unknown `?`, provisional `~`, or finalized output tokens per wall time in the status line. Precision can be `auto`, `1 digit`, or `0 digits`. It sends no notifications, uses no timers, and does not estimate tokens from text or deltas.
- **Context** — percent / tokens, a bottom-right progress bar, standalone track or border style, one-third or remaining width, and hide/show unknown usage.
- **Tokens** — input / output, total, or cache details. Tokens stay off by default.
- **Model** — provider and thinking labels. Model stays last by default.

## Footer composition and bottom details

The custom footer always renders only statuses published by extensions, sorted by status key. Pi's two informational footer rows are not reconstructed and cannot be enabled, avoiding duplicate workspace, usage, context, and model facts.

The input box's bottom-right detail area is always active and has no master switch. It contains only:

- **Context progress** — choose `/glance` → **Context** → `Display` → `progress bar`. `Progress style: track` preserves the standalone `╶───────────╴ 23%` renderer. `Progress style: border` uses the input border itself: unused cells stay light `─`, used cells become heavy `━`, and `╼` joins them. `Progress width` chooses whether progress plus labels use `one third` of the inner width or all `remaining` bottom-border space. The percentage keeps normal text color and bottom progress omits the context icon; Nerd Font text modes still use `󰍛`.
- **Context risk** — below 70% the used section has the context color, from 70% to below 85% it uses warning, and at 85% or higher it uses error. The same fixed thresholds style top-line context text and both bottom progress styles. Filled and unused border colors come from the selected Color source; unknown progress is dim.
- **Auto compact** — appears only while Pi auto-compaction is enabled. Plain mode shows highlighted `auto`; Nerd Font mode shows the highlighted `󰁄 auto` marker. It reflects Pi's merged global/project setting, reading project settings only for trusted projects.

On narrow terminals the progress visualization shrinks first; context takes priority over the auto-compaction marker at the smallest widths. The relevant config is:

```json
{
  "context": {
    "display": "progress",
    "unknown": "show",
    "progressStyle": "border",
    "progressWidth": "third"
  },
  "bottomDetails": {
    "showAutoCompact": true
  }
}
```

## Workspace title

Open `/glance`, select **General**, and set `Workspace label`:

- `name` — show only the current directory name. This is the default.
- `smart` — show more path context on wider terminals.
- `path` — show a safe `~/...` path when possible.

pi-glance never renders full absolute paths in the title: home paths are shortened to `~/...`, and non-home paths use an ellipsis tail such as `…/work/project`.

## Git status

The Git segment is intentionally quiet:

- Clean repositories show only the branch name.
- Dirty repositories add `*` in plain mode or `●` in Nerd Font mode.
- Conflicts add `!` in plain mode or `⚠` in Nerd Font mode.
- Ahead/behind counts appear when Git reports an upstream, for example `↑2 ↓1`.
- Non-Git directories hide the Git segment.

Open `/glance`, select **Git**, move to a value with the arrow keys, and press Enter to configure:

- `Dirty marker` — hide/show normal dirty markers; conflict markers stay visible.
- `Ahead / behind` — hide/show upstream counts.
- `SHA` — `off`, `detached`, or `always`.
- `Polling` — `2s`, `5s`, `10s`, or `30s`.

Git is collected asynchronously and cached. External file changes usually appear within a few seconds. For local development/debugging you can compare pi-glance with Git directly:

```bash
git status --short --branch
pnpm debug:git
```

## Design

- No Pi core patches — public extension APIs only
- No render-time IO — Git is collected asynchronously and cached; Pi settings are sampled during lifecycle refreshes
- The custom Header replaces only Pi's Header component; Pi's separate Context/Skills/Prompts/Extensions summary keeps its native compact/expanded hierarchy. Expanded Extensions stay grouped by project/user/path, with `npm:`/`git:` package sources and local file paths shown by Pi
- Global config at `~/.pi/agent/pi-glance/config.json` (schema version 11; older configs preserve Glance palette behavior and Pi's built-in Header unless explicitly opted in)

## License and attribution

MIT. Original `pi-glance` copyright © 2026 linys77. See [UPSTREAM_SOURCE.md](./UPSTREAM_SOURCE.md), [UPSTREAM_LICENSE](./UPSTREAM_LICENSE), and [UPSTREAM_README.md](./UPSTREAM_README.md) for the exact fork source and preserved upstream materials.
