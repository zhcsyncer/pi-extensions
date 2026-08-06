# @zhcsyncer/pi-subagents

Maintained fork of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) with a **brief ConversationViewer**: dispatch prompt, one-line tool step summaries, and final result — instead of dumping full tool-result walls in the overlay.

Upstream documentation is preserved in [`UPSTREAM_README.md`](./UPSTREAM_README.md). Source pin and local deltas: [`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md).

> Chinese: [README.zh-CN.md](./README.zh-CN.md)

## Try locally (this monorepo)

Do **not** change global `~/.pi/agent/settings.json` unless you intend to replace `@tintinweb/pi-subagents` permanently. For a side-by-side trial from this worktree:

```bash
# from the monorepo root
pnpm install
pi -e ./packages/pi-subagents/src/index.ts
```

If another copy of `pi-subagents` is already loaded from settings, temporarily disable/remove that entry for the trial session so only this fork registers the `Agent` tools and FleetView UI.

### Conversation overlay (scheme A)

Open FleetView / agent list, select a subagent, press Enter:

1. **Header** — name / status / duration / tools / tokens (unchanged)
2. **Prompt** — first meaningful user (dispatch) message
3. **Steps** — one line per tool call (`✓ read path`, `⠹ bash …`, `✗ grep …`); results folded by default
4. **Result** — last non-empty assistant text, or `(running…)` while in flight

Keys (unchanged unless noted):

| Key | Action |
| --- | --- |
| `Esc` / `q` | Close overlay |
| `↑↓` / PgUp/PgDn | Scroll |
| `Enter` | Steer (running agents) |
| `x` `x` | Arm + confirm stop |
| `o` | Toggle expanded tool args/results (**fork**) |

### Tool TUI (main transcript)

`Agent`, `get_subagent_result`, and `steer_subagent` use compact custom renderers:

- **Call line:** type/description plus **model** and **effort** chips (`model: inherit` when unset; `effort:` maps from tool/frontmatter `thinking`)
- **Collapsed (default):** status/stats (model, effort, tools, tokens, …) + one-line result preview — no full transcript wall
- **Expanded (`Ctrl+O` / tools expand):** status header + **Markdown** body

## Package scripts

```bash
pnpm --filter @zhcsyncer/pi-subagents check
pnpm --filter @zhcsyncer/pi-subagents test
pnpm --filter @zhcsyncer/pi-subagents typecheck
```

## License

MIT — see [LICENSE](./LICENSE) and upstream [UPSTREAM_LICENSE](./UPSTREAM_LICENSE).
