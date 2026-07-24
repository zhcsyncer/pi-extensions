<div align="center">

# ◌ pi-glance

**A calm input surface for [pi](https://github.com/badlogic/pi-mono)**

Replace the default prompt with a rounded multiline editor
and an inline glance at Git, cost, Reply speed, context, optional tokens, and model.

[![npm](https://img.shields.io/npm/v/pi-glance?style=flat-square&color=blue)](https://www.npmjs.com/package/pi-glance)
[![license](https://img.shields.io/badge/license-MIT-64748b?style=flat-square)](LICENSE)
[![pi](https://img.shields.io/badge/pi-package-7c3aed?style=flat-square)](https://github.com/badlogic/pi-mono)

</div>

---

## Install

From npm:

```bash
pi install npm:pi-glance
```

Or clone as a traditional pi extension directory:

```bash
git clone https://github.com/LinYS77/pi-glance.git ~/.pi/agent/extensions/pi-glance
```

Then restart pi or run `/reload`.

To update installed packages/extensions, use `pi update --extensions` or `pi update --all`. `pi update` updates Pi itself by default.

Compatibility: current pi-glance releases target Pi packages under `@earendil-works/*` and the Node runtime supported by current Pi. If your Pi installation still exposes the older package namespace or runs on Node 20, pin `pi-glance@0.3.0` or upgrade Pi before updating pi-glance.

For development/testing:

```bash
pi -e /path/to/pi-glance
```

Local checks and Git diagnostics:

```bash
npm test
npm run test:git
npm run debug:git
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
- **Context** — percent / tokens, or hide unknown usage.
- **Tokens** — input / output, total, or cache details. Tokens stay off by default.
- **Model** — provider and thinking labels. Model stays last by default.

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
npm run debug:git
```

## Design

- No pi core patches — public extension APIs only
- No render-time IO — Git is collected asynchronously and cached
- Global config at `~/.pi/agent/pi-glance/config.json`

## License

[MIT](LICENSE) © 2026 linys77
