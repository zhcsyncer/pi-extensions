# @zhcsyncer/pi-plan-mode

[简体中文](./README.zh-CN.md)

A strict, TUI-only planning and approval workflow for Pi. It combines fail-closed read-only tools, terminal review through [revdiff](https://github.com/umputun/revdiff), immutable Plan revisions, explicit approval, a branch-aware implementation lifecycle, and compact Plan widgets.

Plan document review and implementation work are tracked independently. Approval restores the tools that were active before planning, starts ordinary implementation in a fresh agent turn, and activates `complete_plan`. Completion closes only the exact approved revision and makes the next `/plan on` start a new Plan by default.

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
- Approval restores normal tools, removes the read-only mode bar, retains the Plan summary, enters `IMPLEMENTING`, and starts implementation through a displayed custom context message rather than a user-role turn. The transcript renders only a compact approval event while the full approved revision remains in model context.
- `complete_plan` is active only for implementing or migrated legacy work. It requires the exact Plan ID/revision, an implementation summary, and successful verification checks; its result is terminating and must be the final tool call.
- `/plan complete` is the user fallback when the agent did not close the work. `/plan abandon` closes it without claiming completion.
- Re-entering Plan Mode while work is still implementing requires an explicit choice: revise it, mark it complete and start a new Plan, abandon it and start a new Plan, or cancel.
- Steps remain a display-only projection of `## Execution steps` or `## 执行步骤`. Work completion does not mutate individual Steps and does not integrate with or inspect Todo extensions.
- `submit_plan` and `complete_plan` use compact self-rendered transcript nodes. Approved/completed nodes stay hidden while collapsed because the persistent approval/lifecycle event is authoritative; `Ctrl+O` reveals Plan IDs, paths, hashes, completion evidence, and persisted review annotations.
- Herdr integration is automatic and optional. Plan Mode emits Herdr's reserved `herdr:blocked` event around revdiff review, approval/lifecycle selectors, and completion/abandonment confirmations, then always clears it in `finally`. Non-Herdr environments simply have no listener.
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
7. Approval records the exact revision and hash, turns Plan Mode off, restores normal tools, marks that exact revision `IMPLEMENTING`, and starts ordinary implementation in a fresh turn.
8. After all approved scope is implemented and necessary verification passes, the agent calls `complete_plan`. The work becomes `COMPLETED`; the next `/plan on` starts unattached and creates a new Plan.

Interrupting implementation still has normal Pi semantics. The approved Plan and its branch-aware work state survive resume and tree navigation, but the extension does not track per-step execution progress or restart work automatically. Use `/plan revise` to explicitly attach the approved revision again.

## Commands and shortcuts

| Interaction | Behavior |
|---|---|
| `/plan on` | Enable strict read-only Plan Mode; completed/abandoned work starts a new unattached Plan |
| `/plan off` | Disable Plan Mode and restore normal tools |
| `/plan revise` | Explicitly attach the current approved work for a new immutable revision |
| `/plan complete` | Confirm that all approved work and necessary verification are complete |
| `/plan abandon` | Close the current approved work without claiming completion |
| `/plan` | Show current mode, content language/config path, document focus, work state, revision, path, and usage |
| `--plan` | Start the initial TUI Session with Plan Mode on |
| `Ctrl+Alt+P` | Toggle Plan Mode |
| `Ctrl+Alt+O` | Expand or collapse the current Plan Steps |

All `/plan` actions support command argument completion.

## Plan content language

Plan Mode reads one optional user-level file from `<agent-dir>/extension-data/pi-plan-mode/config.json` (normally `~/.pi/agent/extension-data/pi-plan-mode/config.json`):

```json
{
  "contentLanguage": "zh-CN"
}
```

Supported values:

- `auto` (default): honor higher-priority or explicit user language instructions; otherwise match the current user. Simplified Chinese Plans use Chinese section headings, and other Plans use English headings.
- `en`: require English title, content, and section headings.
- `zh-CN`: require Simplified Chinese title, content, and section headings.

Reload or restart Pi after editing it. On first load, the previous `plan-mode.json` path is automatically migrated and upgraded; unmappable fields are dropped with a warning. Invalid JSON or an unsupported value is preserved, produces a warning, and falls back to `auto`. This setting controls generated Plan content and headings only; Plan Mode UI, revdiff UI, control prompts, and approval events remain English.

## Widgets

While Plan Mode is on, a below-editor widget is rendered with the standard Unicode pause symbol:

```text
⏸ PLAN MODE · READ-ONLY                    /plan off · Ctrl+Alt+P
```

The extension uses Unicode `⏸` directly. It does not add a font setting, environment variable, Nerd Font branch, or ASCII fallback.

After a Plan exists, an above-editor summary remains visible independently of whether Plan Mode is on. During implementation it shows the work lifecycle rather than conflating it with document approval:

```text
▌ PLAN  OAuth migration                           IMPLEMENTING · r2
6 steps                                             Ctrl+Alt+O expand
```

After explicit completion it becomes `COMPLETED · r2`; abandonment becomes `ABANDONED · r2`. A fresh `/plan on` hides the old summary so the new planning turn is unattached.

The Plan path is intentionally hidden while collapsed. Expanding shows the path and the display-only Steps:

```text
▌ PLAN  OAuth migration                           IMPLEMENTING · r2
~/.pi/agent/plans/…/revisions/r2.md
Document: APPROVED
Approved hash: sha256:…
  1. Update the policy
  2. Run integration tests
                                              Ctrl+Alt+O collapse
```

Steps are collapsed by default. `Ctrl+Alt+O` expands up to 30% of terminal height, bounded to 3–10 steps; overflow is shown as `… +N more`. Expansion is TUI-local and resets when the current Plan, revision, Session, or tree branch changes.

Approval and work closure add compact events to the transcript:

```text
✓ PLAN APPROVED · OAuth migration · r2 · 6 steps
✓ PLAN COMPLETED · OAuth migration · r2
! PLAN ABANDONED · OAuth migration · r2
```

Successful `submit_plan` and `complete_plan` nodes are hidden while tool output is collapsed, avoiding duplicate events. Expand tool output with Pi's configured `app.tools.expand` binding (normally `Ctrl+O`) to inspect review annotations, paths, hashes, summaries, and verification evidence. Historical annotation rendering uses persisted tool-result content and never depends on the temporary `.review/annotations.md` file.

Persistent widgets do not receive focus and Pi's public Widget API has no mouse click callback, so direct clicking is not supported.

## Storage

Persistent Sessions store application data separately from Pi JSONL transcripts. Only the optional language config moves under `extension-data`; Plan artifacts remain at their stable path:

```text
~/.pi/agent/extension-data/pi-plan-mode/config.json
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

Implementation work state is deliberately not stored in the immutable artifact. Pi custom Session entries store separate `planning` and `work` references, including the exact approved revision/hash and `implementing`, `completed`, `abandoned`, or legacy `unknown` state. These entries follow the active Session tree branch. Legacy V2 approved pointers migrate to `unknown`; they are never guessed to be completed.

With `--no-session`, the extension uses `$TMPDIR/pi-plan-<random>/`, keeps lifecycle state only in memory, never appends Session state or lifecycle events, and removes the directory on Session shutdown. Crash leftovers may remain until the operating system cleans its temporary directory.

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

Omitting `planId` creates a new Plan only when no revision is attached. Once a draft or explicit revision is attached, `submit_plan` requires that exact ID; use `/plan revise` to attach approved work. Arbitrary, stale, or cross-Session adoption is rejected.

After approval, completion uses the exact work binding:

```text
complete_plan({
  planId: "20260723T140506-add-cache-a1b2c3d4",
  revision: 2,
  summary: "Implemented cache invalidation and rollback handling",
  verification: ["pnpm test", "pnpm typecheck"]
})
```

`verification` must contain at least one successful check. The tool also re-verifies the approved artifact hash before recording completion. It cannot prove arbitrary project correctness, so the agent/user declaration remains explicit rather than inferred from final prose, file changes, or command history.

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
- Legacy approved Session state: restore as `UNKNOWN` work and require an explicit revise/complete/abandon decision.
- `complete_plan` ID/revision mismatch or approved-content/hash mismatch: reject completion without changing lifecycle state.
- Re-entering with `IMPLEMENTING`/`UNKNOWN` work: require an explicit choice; never silently revise it or silently start parallel current work.
- `/plan off`: restore normal tools without deleting or cancelling the current draft.

## Development

```bash
pnpm --filter @zhcsyncer/pi-plan-mode check
pi --no-extensions -e ./packages/pi-plan-mode --list-models nope
```

## License

MIT
