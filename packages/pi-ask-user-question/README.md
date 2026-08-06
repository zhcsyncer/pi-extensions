# pi-ask-user-question

[简体中文](./README.zh-CN.md)

A structured questionnaire extension for Pi, maintained from `@juicesharp/rpiv-ask-user-question`. It registers the `ask_user_question` tool so the model can ask 1–4 documented single-select or multi-select questions at once when requirements are ambiguous.

This fork renders the questionnaire in Pi's normal custom-component layout instead of a full-screen overlay over the bottom area. It also adds context-aware numeric selection and an auditable result view after the interaction finishes.

## Install

Install only the questionnaire extension:

```bash
pi install npm:@zhcsyncer/pi-ask-user-question
```

Or install the complete extension bundle:

```bash
pi install npm:@zhcsyncer/pi-extensions
```

## Interaction

- `1`–`5`: when `Type something.` is not focused, `1`–`N` selects or toggles a defined option directly, while `N+1` focuses `Type something.`.
- `↑` / `↓`: move focus.
- `Enter`: confirm the focused single-select option; in multi-select questions, toggle the focused option or submit the question when `Next` is focused.
- `Space`: toggle the focused multi-select option.
- `Tab` / `Shift+Tab`: move between questions and the submit page in a multi-question questionnaire.
- `n`: add a note to the current question.
- `Esc`: cancel the entire questionnaire.
- `Ctrl+]`: collapse the questionnaire to one line or restore it; the shortcut can be changed or disabled in configuration.

Every question automatically includes a `Type something.` row for answers outside the authored options. Before text entry begins, press the number immediately following the defined options to focus that row. Once focused, every digit is entered as ordinary text. A multi-select question's `Next` row still requires navigation and `Enter`, preventing accidental submission through numeric shortcuts.

## TUI Layout and Tool Rendering

The questionnaire uses non-overlay `ctx.ui.custom()` rendering. During the interaction it temporarily replaces the bottom editor, preserves and later restores its draft, and participates in Pi's normal layout calculation so the transcript reflows while the footer remains separately visible.

No additional pending tool call is shown while the questionnaire is active. After completion, the result node shows each answer, its answer type, and any note; expanding it reveals length-limited previews for selected options. Cancellation retains partial answers for auditing, and validation or runtime errors remain visible. In a wide side-by-side layout, the content-width preview box is centered within the remaining columns on the right.

## Configuration

Global configuration lives at `$PI_CODING_AGENT_DIR/extension-data/pi-ask-user-question/config.json` (by default `~/.pi/agent/extension-data/pi-ask-user-question/config.json`). On first read, the former `$XDG_CONFIG_HOME/rpiv-ask-user-question/config.json` or `~/.config/rpiv-ask-user-question/config.json` file is migrated atomically. Canonical data always wins; malformed, unreadable, or conflicting legacy files are retained with a de-duplicated warning.

```json
{
  "collapseKey": "alt+o",
  "guidance": {
    "promptSnippet": "Ask before guessing when requirements are ambiguous"
  }
}
```

Set `collapseKey` to `"off"` to disable the collapse shortcut. Use `guidance.promptSnippet` and `guidance.promptGuidelines` to override the default model guidance.

## Provenance

- Upstream: [`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question)
- Baseline: `@juicesharp/rpiv-ask-user-question@2.4.0` / `a1531ed4207c21a00941c62571bc1bd3e386cfcb`
- Preserved upstream documentation: [`UPSTREAM_README.md`](./UPSTREAM_README.md)
- Preserved upstream history: [`UPSTREAM_CHANGELOG.md`](./UPSTREAM_CHANGELOG.md)

## Development

```bash
pnpm --filter @zhcsyncer/pi-ask-user-question check
pi --no-extensions -e ./packages/pi-ask-user-question --list-models __pi_ask_user_question_check__
```

## License

MIT. See [`LICENSE`](./LICENSE) and [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE).
