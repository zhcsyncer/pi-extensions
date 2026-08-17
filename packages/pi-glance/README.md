<div align="center">

# ◌ @zhcsyncer/pi-glance

[简体中文](./README.zh-CN.md)

**A calm, composable input surface for [Pi](https://github.com/earendil-works/pi-mono)**

Replace the default prompt with a rounded multiline editor and an inline glance at Git, cost, Reply speed, context, optional tokens, and model—without hiding statuses published by other extensions.

This package is a maintained fork of [`pi-glance`](https://github.com/LinYS77/pi-glance) 0.5.3. It adds a status-only footer, Follow Pi theme integration, bottom-right context and auto-compaction details, and a switchable Claude-inspired working indicator. Upstream 0.5.3 does not include the working indicator.

[![npm](https://img.shields.io/npm/v/%40zhcsyncer%2Fpi-glance?style=flat-square&color=blue)](https://www.npmjs.com/package/@zhcsyncer/pi-glance)
[![license](https://img.shields.io/badge/license-MIT-64748b?style=flat-square)](LICENSE)
[![pi](https://img.shields.io/badge/pi-package-7c3aed?style=flat-square)](https://github.com/earendil-works/pi-mono)

</div>

---

## Install

```bash
pi install npm:@zhcsyncer/pi-glance
```

Then restart Pi or run `/reload`.

Needs Pi 0.80.4 or newer.

## Use

```text
/glance
/diff
```

`/glance` opens settings with a live input-surface preview. `/diff` hands the terminal to optional [`revdiff`](https://revdiff.com/) for an uncommitted working-tree review; annotations return to the editor for you to confirm and are never sent automatically. If revdiff is missing, only `/diff` shows the install hint.

`Ctrl+S` stashes or restores the current editor draft. `Ctrl+Q` discards the stash after a second press. The left border shows a short mark while a draft is waiting. Reloading or resuming the same session restores it automatically if the editor is empty.

## What you see

![pi-glance demo](./assets/demo.png)

| | | |
|---|---|---|
| 🖊️ | **Rounded editor** | 2 / 3 / 4 min rows and 0 / 1 / 2 top spacing rows |
| 🏷️ | **Project title** | Folder name, or a safe `~/...` path |
| 📊 | **Inline status** | Git · cost · Reply speed · context · optional tokens · model |
| Δ | **Working tree** | File count and tracked `+N −N` in the Git line, or on the bottom-right border |
| ⚙️ | **`/glance` pane** | General settings, segment order, and per-segment options |
| 💤 | **Dim unfocused** | Surface quiets when you scroll the chat |
| 🎨 | **Themes** | Follow Pi theme tokens by default, with 22 Glance palettes as fallback |
| 📥 | **Editor stash** | `Ctrl+S` stashes or restores, `Ctrl+Q` discards after a second press; the border marks an unrestored draft |
| ✢ | **Working indicator** | Spinner, activity, current-cycle output, and elapsed time |

Other extensions' `ctx.ui.setStatus()` values remain visible below the editor. Glance does not restore Pi's two informational footer rows.

## Settings

Open `/glance`:

- **General** — `Color source` is `Follow Pi` on new installs. Choose `Glance palette` to use the 22 built-in palettes. `Light palette` and `Dark palette` are the fallback when the current Pi theme is unavailable. `Icons` default to `plain`; `nerd` needs a Nerd Font. If icons look like boxes, choose `plain`. `Workspace label` is `name`, `smart`, or `path`.
- **Working indicator** — one `Enabled: on/off` switch in the first-level menu. `off` restores Pi's default working row.
- **Git** — `Dirty marker` (hidden while file counts are visible; conflicts stay), `Ahead / behind`, `Behind main`, `SHA`, `Working tree` (`status` or `border right`), and `Polling`.
- **Reply speed** — enabled by default. Shows output tokens per wall time: `?` unknown, `~42 tok/s` provisional, `42 tok/s` final. `Precision` is `auto`, `1 digit`, or `0 digits`. Wall time includes tools, waiting, network, and thinking, so it is not a benchmark. It sends no notifications, uses no timers, and does not estimate tokens from text.
- **Context** — text as percent / tokens, plus an optional bottom-right `Progress bar` (`track` or `border`, `one third` or `remaining`). Unused border cells stay light `─`, used cells become heavy `━`. Below 70% is normal, 70% to below 85% is warning, 85% or higher is error.
- **Bottom details** — hide the auto-compaction marker if you want. Nerd Font mode shows `󰁄 auto`.

Git stays quiet:

- Clean trees show only the branch name.
- Dirty trees add `*` / `●` unless Working Tree file counts are already visible, for example `main Δ6 +123 −99`.
- Conflicts add `!` / `⚠`.
- Upstream counts look like `↑2 ↓1`.
- Behind the last local `origin/main` adds highlighted `main↓N`. It stays hidden when the count is 0, `origin/main` is missing, or upstream `↓N` is already showing that same lag.

`/diff` is optional. Glance and the working-tree summary stay available without revdiff.

## Working indicator

**Fork difference:** provided by this package; upstream `pi-glance` 0.5.3 does not include it.

While a high-level cycle is active, Glance shows a themed spinner, a stable per-cycle verb, current activity, cycle output, and elapsed time (`47s`, `3m 08s`, `1h 07m`). Elapsed time uses the theme warning color at five minutes or later. It is not an official Anthropic component and does not change the Agent, prompts, models, tools, messages, or session behavior.

The working row is the current cycle's output. Top-border Tokens are session cumulative usage. Context is context-window occupancy. Empty partials stay hidden instead of showing `↓ ~0 tokens`.

## License

MIT. Original `pi-glance` copyright © 2026 linys77. See [UPSTREAM_SOURCE.md](./UPSTREAM_SOURCE.md), [UPSTREAM_LICENSE](./UPSTREAM_LICENSE), and [UPSTREAM_README.md](./UPSTREAM_README.md).
