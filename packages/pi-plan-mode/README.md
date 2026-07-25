# @zhcsyncer/pi-plan-mode

[简体中文](./README.zh-CN.md)

A strict, TUI-only permission mode for planning in Pi. It combines fail-closed read-only tools, terminal review through [revdiff](https://github.com/umputun/revdiff), immutable Plan revisions, explicit approval, and compact Plan Mode widgets.

Plan Mode is temporary: approval immediately restores the tools that were active before planning and starts ordinary implementation in a fresh agent turn. The extension does not maintain an execution or completion workflow.

## Requirements

- Node.js 22.19 or newer
- Pi 0.81 or newer
- `revdiff` available in `PATH`, or `REVDIFF_BIN` pointing to an executable binary
- Pi TUI mode

The extension checks revdiff when each TUI Session starts. If it is missing or not executable, Pi shows an installation warning and keeps Plan Mode disabled for that Session. Install revdiff and restart Pi.

On macOS with Homebrew:

```bash
brew install umputun/apps/revdiff
```

## Behavior

- `/plan on` enters read-only planning; `/plan off` immediately restores the previous normal tools. Starting Pi with `--plan` is equivalent to the initial `/plan on`.
- `Ctrl+Alt+P` toggles the same mode. `/plan` without an argument shows status and usage instead of toggling implicitly.
- Planning uses a fail-closed allowlist: `read`, `grep`, `find`, `ls`, approved documentation/search/question tools, and `submit_plan`.
- `bash`, `edit`, `write`, and unknown custom tools are blocked while Plan Mode is on.
- The original Pi system prompt, including `AGENTS.md` rules, is preserved and extended rather than replaced.
- A clean revdiff exit is not approval. Pi asks for an explicit `Approve Plan`, `Keep planning`, or `Cancel review` decision.
- Every complete submission creates an immutable `rN` Markdown file and SHA-256 hash. Approved revisions are never overwritten.
- Approval restores normal tools, removes the read-only mode bar, retains the Plan summary, and starts implementation through a displayed custom context message rather than a user-role turn. The transcript renders only a compact approval event while the full approved revision remains in model context.
- Steps are a display-only projection of `## Execution steps` or `## 执行步骤`. They have no completion state and do not integrate with or inspect Todo extensions.
- Plan title, prose, lists, and required section headings can use English, Simplified Chinese, or automatically follow the conversation language through a read-only user config file.
- TUI-only behavior is enforced with `ctx.mode === "tui"`. RPC, JSON, and print modes do not register Plan tools, change active tools, inject prompts, or write Plan state.

This is a capability boundary, not an OS sandbox. Read tools can still access files allowed by the Pi process.

## Workflow

1. Run `/plan on`, press `Ctrl+Alt+P`, or start Pi with `--plan`.
2. The agent explores with read-only tools.
3. The agent calls `submit_plan` with a title and the complete Markdown Plan.
4. Pi pauses its TUI and gives the terminal to revdiff.
5. Annotations are returned as one feedback package. A complete resubmission creates `rN+1` and opens a revision diff with revdiff word-level highlighting.
6. A clean review returns to Pi for an explicit approval decision.
7. Approval records the exact revision and hash, turns Plan Mode off, restores normal tools, and starts ordinary implementation in a fresh turn.

Interrupting implementation has normal Pi semantics. The approved Plan remains available, but this extension does not track execution progress, restart work automatically, or require a completion tool. Re-entering Plan Mode injects the attached revision as planning context; the agent must still inspect the current workspace before revising it.

## Commands and shortcuts

| Interaction | Behavior |
|---|---|
| `/plan on` | Enable strict read-only Plan Mode |
| `/plan off` | Disable Plan Mode and restore normal tools |
| `/plan` | Show current mode, content language/config path, Plan revision, path, and usage |
| `--plan` | Start the initial TUI Session with Plan Mode on |
| `Ctrl+Alt+P` | Toggle Plan Mode |
| `Ctrl+Alt+O` | Expand or collapse the current Plan Steps |

`on` and `off` support command argument completion.

## Plan content language

Plan Mode reads one optional user-level file from `<agent-dir>/plan-mode.json` (normally `~/.pi/agent/plan-mode.json`):

```json
{
  "contentLanguage": "zh-CN"
}
```

Supported values:

- `auto` (default): honor higher-priority or explicit user language instructions; otherwise match the current user. Simplified Chinese Plans use Chinese section headings, and other Plans use English headings.
- `en`: require English title, content, and section headings.
- `zh-CN`: require Simplified Chinese title, content, and section headings.

The extension only reads this file and never creates or rewrites it. Reload or restart Pi after editing it. Invalid JSON or an unsupported value produces a warning and falls back to `auto`. This setting controls generated Plan content and headings only; Plan Mode UI, revdiff UI, control prompts, and approval events remain English.

## Widgets

While Plan Mode is on, a below-editor widget is rendered with the standard Unicode pause symbol:

```text
⏸ PLAN MODE · READ-ONLY                    /plan off · Ctrl+Alt+P
```

The extension uses Unicode `⏸` directly. It does not add a font setting, environment variable, Nerd Font branch, or ASCII fallback.

After a Plan exists, an above-editor summary remains visible independently of whether Plan Mode is on:

```text
▌ PLAN  OAuth migration                              APPROVED · r2
6 steps                                             Ctrl+Alt+O expand
```

The Plan path is intentionally hidden while collapsed. Expanding shows the path and the display-only Steps:

```text
▌ PLAN  OAuth migration                              APPROVED · r2
~/.pi/agent/plans/…/revisions/r2.md
  1. Update the policy
  2. Run integration tests
                                              Ctrl+Alt+O collapse
```

Steps are collapsed by default. `Ctrl+Alt+O` expands up to 30% of terminal height, bounded to 3–10 steps; overflow is shown as `… +N more`. Expansion is TUI-local and resets when the current Plan, revision, Session, or tree branch changes.

Approval adds one compact custom event to the transcript:

```text
✓ PLAN APPROVED · OAuth migration · r2 · 6 steps
```

Persistent widgets do not receive focus and Pi's public Widget API has no mouse click callback, so direct clicking is not supported.

## Storage

Persistent Sessions store application data separately from Pi JSONL transcripts. The optional language config is a sibling of the `plans/` directory:

```text
~/.pi/agent/plan-mode.json
~/.pi/agent/plans/
└── <plan-id>/
    ├── manifest.json
    ├── revisions/
    │   ├── r1.md
    │   └── r2.md
    └── .review/
        └── annotations.md
```

The root is resolved with Pi's `getAgentDir()`, so `PI_CODING_AGENT_DIR` is respected. Directories use mode `0700`; revision and manifest files use `0600` where supported.

Each submission writes a new revision with exclusive creation. The manifest records the stable Plan ID, current and approved revisions, document states (`draft`, `changes_requested`, or `approved`), SHA-256 hashes, extracted display Steps, Session ID, cwd, timestamps, and revision lineage.

With `--no-session`, the extension uses `$TMPDIR/pi-plan-<random>/`, never appends Session state, and removes the directory on Session shutdown. Crash leftovers may remain until the operating system cleans its temporary directory.

## Plan artifact

`submit_plan` accepts the complete artifact, not a file path:

```text
submit_plan({
  title: "Add cache invalidation",
  markdown: "# Goal\n..."
})
```

When revising the same Plan, pass the current Plan ID returned by the previous submission:

```text
submit_plan({
  planId: "20260723T140506-add-cache-a1b2c3d4",
  title: "Add cache invalidation",
  markdown: "# Goal\n... complete revised Plan ..."
})
```

Omitting `planId` creates a different Plan. A supplied ID must match the current Session branch Plan; arbitrary or cross-Session adoption is rejected.

Plans are limited to 256 KiB and should cover the nine required sections. English Plans use Goal, Non-goals, Current evidence, Decisions and rationale, Proposed changes, Execution steps, Verification, Risks, and Assumptions. Simplified Chinese Plans use 目标、非目标、当前证据、决策与理由、拟议改动、执行步骤、验证、风险和假设.

## Install

Install only this extension:

```bash
pi install npm:@zhcsyncer/pi-plan-mode
```

Try it from this repository:

```bash
pi --no-extensions -e ./packages/pi-plan-mode
```

## Failure behavior

- Missing or non-executable revdiff at startup: warn with installation guidance and disable Plan Mode for the Session.
- revdiff removed, too old for `--word-diff`, or failing after startup: remain in planning and report an error.
- Invalid `plan-mode.json`: warn, use `contentLanguage: "auto"`, and keep Plan Mode available.
- Interrupted review: remain in planning without approval.
- Plan content or current revision changed while revdiff is open: reject approval and require another review.
- Missing or cross-Session metadata during restore: keep normal mode and do not adopt that Plan pointer.
- `/plan off`: restore normal tools without deleting or cancelling the current draft.

## Development

```bash
pnpm --filter @zhcsyncer/pi-plan-mode check
pi --no-extensions -e ./packages/pi-plan-mode --list-models nope
```

## License

MIT
