# Configuration

Every setting the package reads, where the file lives, and what happens when a value is
wrong.

## The config file

```text
$PI_CODING_AGENT_DIR/extension-data/pi-ask-user-question/config.json
```

Pi's default agent directory makes this
`~/.pi/agent/extension-data/pi-ask-user-question/config.json`. The file is optional —
with no config at all, every setting takes its default. Normal operation only reads the
canonical file; the package writes it with owner-only permissions during a successful
one-time legacy migration.

A complete example:

```json
{
  "collapseKey": "alt+o",
  "guidance": {
    "promptSnippet": "Ask me before guessing on anything ambiguous",
    "promptGuidelines": [
      "Batch every clarifying question into one ask_user_question call.",
      "Put your recommended option first and suffix it with (Recommended)."
    ]
  }
}
```

### Where the file is looked up

1. The canonical `$PI_CODING_AGENT_DIR/extension-data/pi-ask-user-question/config.json`
   file wins whenever it exists. A malformed or unreadable canonical file is reported and
   is never replaced from a legacy source.
2. If canonical config is absent, the loader checks
   `$XDG_CONFIG_HOME/rpiv-ask-user-question/config.json` when `XDG_CONFIG_HOME` is
   non-empty and absolute. A leading `~` is expanded; a relative value is ignored.
3. If that XDG file is absent, it checks the historical
   `~/.config/rpiv-ask-user-question/config.json` fallback.
4. A valid legacy object is written to a same-directory temporary file, atomically renamed
   to the canonical path, parsed again, and compared semantically. Only then is the migrated
   legacy file removed. If the write or verification fails, the legacy value remains the
   runtime fallback and its file is retained.

When canonical and legacy files coexist, canonical content wins. Semantically equivalent
legacy data may be removed after canonical re-read; malformed, unreadable, or conflicting
legacy data is retained with a warning. Repeated loads do not repeat the same warning in one
process.

### When the file is invalid

Malformed JSON, unreadable files, and JSON roots that are not objects are not fatal. The
loader warns on stderr and continues with defaults. A bad canonical file is never masked by
legacy data, and a bad legacy file is never deleted.

Individual `collapseKey` and `guidance` values keep their previous behavior: the raw object
is loaded, while each consumer validates its own field. Invalid collapse-key specs and
invalid guidance fields therefore fall back to the built-in defaults without rewriting the
user's canonical file.

## Settings

| Setting | What it does | Default |
| --- | --- | --- |
| `collapseKey` | Key that collapses and expands the active questionnaire component. | `"ctrl+]"` |
| `guidance.promptSnippet` | One-line snippet describing the tool in the system prompt. | built-in snippet |
| `guidance.promptGuidelines` | List of usage guidelines given to the model. | 4 built-in guidelines |

### `collapseKey`

The value uses Pi's keybinding id format: zero or more distinct modifiers from `ctrl`,
`shift`, `alt`, `super`, joined by `+`, followed by a base key. Values are trimmed and
lowercased before matching.

The base key is either a single printable character from
`a-z 0-9 _ - ! @ # $ % ^ & * ( ) | ~ \` ' " : ; , . / < > ? [ ] { } = \`, or one of the
named keys `escape`, `esc`, `enter`, `return`, `tab`, `space`, `backspace`, `delete`,
`insert`, `clear`, `home`, `end`, `pageup`, `pagedown`, `up`, `down`, `left`, `right`,
`f1`–`f12`.

Examples that work: `"ctrl+]"`, `"alt+o"`, `"ctrl+shift+h"`, `"f9"`, `"ctrl+}"`.

Set `"off"` (any casing) to disable the collapse shortcut entirely.

A spec that does not match the grammar is rejected and the default is used. This is
strict on purpose: Pi's parser takes the last `+`-separated part as the key and ignores
unknown parts, so a typo like `"ctr+]"` could otherwise match every bare `]` keypress.

One known rough edge: the footer hint line inside the dialog always reads `Ctrl+] to
collapse` and does not interpolate a custom `collapseKey`.

### `guidance.promptSnippet` and `guidance.promptGuidelines`

These replace the text Pi puts in the system prompt about when to reach for
`ask_user_question`. Use them to make the model ask more or less often, or to enforce a
house style for options.

`promptSnippet` is used only when it is a non-empty string. `promptGuidelines` is used
only when it is a non-empty array whose entries are all non-empty strings. Anything else
falls back to the built-in defaults. Both are read once, when the extension registers the
tool, so changes take effect on the next Pi restart.

## Environment variables

| Variable | Effect |
| --- | --- |
| `PI_CODING_AGENT_DIR` | Sets Pi's global agent directory and therefore the canonical extension-data path. Defaults to `~/.pi/agent`. |
| `XDG_CONFIG_HOME` | Used only to discover the former rpiv config during one-time migration. Must be absolute after optional leading-`~` expansion. |

`LANG` and `LC_ALL` influence the dialog language, but they are read by
[`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n) rather than
by this package — see [localization.md](./localization.md).

`HOME` supplies the default agent directory through Pi and the historical `~/.config`
legacy fallback. No other package-specific environment variables are read. The package
makes no model calls, so it needs no API keys or model settings of its own.
