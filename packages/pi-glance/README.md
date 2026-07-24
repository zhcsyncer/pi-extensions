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
| 🖊️ | **Rounded editor** | Configurable 2 / 3 / 4 min rows and 0 / 1 / 2 top spacing rows, preserves all pi defaults |
| 🏷️ | **Project title** | Current folder name, or a safe `~/...` path when enabled |
| 📊 | **Inline status** | Git · cost · Reply speed · context · optional tokens · model — top-right |
| ⚙️ | **`/glance` pane** | General settings, segment order, and per-segment detail settings in a calm grid |
| 💤 | **Dim unfocused** | Surface quiets down when you scroll the chat |
| 🎨 | **Themes** | 22 built-in palettes, from Light/Dark to Catppuccin, Solarized, Gruvbox, Rosé Pine, One, Kanagawa, Everforest, and High Contrast |

## Notes

- To switch themes, open `/glance` → **General** → `Light theme` or `Dark theme`, press Enter, preview palettes in the browser, then press Enter to accept or Esc/Left to return. Both rows can choose from all 22 built-in Glance palettes: the Light theme browser lists light-toned palettes first and the Dark theme browser lists dark-toned palettes first, but neither browser filters the catalog. Built-ins: Light, Dark, Catppuccin Latte/Mocha/Frappé/Macchiato, Nord, Tokyo Night, Gruvbox Light/Dark, Solarized Light/Dark, Rosé Pine/Dawn, One Light/Dark, Kanagawa Wave/Lotus, Everforest Light/Dark, and High Contrast Light/Dark.
- Icons default to `plain` so pi-glance works with normal terminal fonts.
- Editor top spacing is configurable: open `/glance` → **General** → `Top spacing` and choose `none`, `1 row`, or `2 rows`.
- `nerd` icons are opt-in: open `/glance` → **General** → `Icons` and choose `nerd` for richer symbols.
- Nerd icons need a Nerd Font or Symbols Nerd Font fallback. If icons look like boxes, choose `plain`.
- pi-glance does not auto-detect, install, or bundle terminal fonts.
- Other extensions' `ctx.ui.setStatus()` values remain visible below the editor. Glance permanently omits Pi's two informational footer rows because the input surface already shows those primary facts; there is no setting to restore them.
- Bottom-right details are always active and have no master switch. Choose `/glance` → **Context** → `Display` → `progress bar` to move context there, then choose a standalone `track` or a progress-aware `border` plus `one third` or `remaining` width. Auto-compaction is shown when enabled and can be hidden under **Bottom details**.
- Reply speed is enabled by default and appears between cost and context. It shows output tokens per wall time: `?` means no trusted measurement yet, `~42 tok/s` is a provisional current-run checkpoint from completed turns, and `42 tok/s` is the finalized agent-end measurement.
- Configure `/glance` → **Reply speed** → `Precision`: `auto`, `1 digit`, or `0 digits`. Wall time includes tools, waiting, network, and thinking, so it is not a benchmark. Reply speed uses no notifications, no timers/tickers, no token estimation from text/deltas, and adds no command, footer, dashboard, history, or average view.

## Themes and config

pi-glance uses its own curated 22 built-in Glance palettes. It is not a Pi theme manager: it does not enumerate, switch, or install Pi UI themes, and it does not render with Pi theme token colors.

The supported config model is `theme: { light: GlanceThemeName, dark: GlanceThemeName }`. New installs default to:

```json
{
  "theme": {
    "light": "light",
    "dark": "dark"
  }
}
```

When pi-glance loads an older config, migration is conservative: an old string such as `{ "theme": "x" }` is preserved as `{ "theme": { "light": "x", "dark": "x" } }` when `x` is one of the built-in Glance theme names.

At render time, pi-glance reads only Pi's public UI theme name to choose a slot:

- exact `light` selects `theme.light`
- exact `dark` selects `theme.dark`
- unknown or custom Pi theme names fall back to `theme.light`

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
- **Context risk** — below 70% the used section has the context color, from 70% to below 85% it uses warning, and at 85% or higher it uses error. The same fixed thresholds style top-line context text and both bottom progress styles. Unknown progress is dim.
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
- Global config at `~/.pi/agent/pi-glance/config.json` (schema version 10; older configs migrate automatically and obsolete footer/detail switches are dropped)

## License and attribution

MIT. Original `pi-glance` copyright © 2026 linys77. See [UPSTREAM_SOURCE.md](./UPSTREAM_SOURCE.md), [UPSTREAM_LICENSE](./UPSTREAM_LICENSE), and [UPSTREAM_README.md](./UPSTREAM_README.md) for the exact fork source and preserved upstream materials.
