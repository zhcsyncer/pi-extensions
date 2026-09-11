# pi-recap

[中文文档](./README.zh-CN.md)

`pi-recap` is a Pi extension that generates a **recent activity recap**. It is not compaction and does not replace or shrink the LLM context.

Features:

- Generate a recent activity recap with `/recap`.
- Automatically recap after the agent has been idle for a while.
- Cancel an unfinished automatic recap when a new message arrives, preventing stale results from being stored or displayed.
- Display automatic recap progress plus recap results and errors in an editor widget, without duplicating successful results in chat notifications.
- Generate a short title as a recap side effect, with a deterministic recap-derived fallback and visible warning when the model omits a usable title.
- Reject empty, truncated, failed, or malformed JSON-like model output without saving partial recap state.
- Optionally apply the title to the Pi session name with `title.applyPolicy`: `off`, `if-empty`, `if-empty-or-auto`, or `always`. `off` leaves the name alone.
- Optionally sync Pi session name changes to the nearest terminal multiplexer: a Herdr pane label or tmux window name.
- `/recap` is always available. `/recap-config` only keeps auto recap, idle wait, model, language, session-name policy, plus multiplexer enablement and template.
- `/recap-config json` remains available as an escape hatch, but is not required for normal use.

### Installation

Install the whole `zhcsyncer/pi-extensions` bundle from Git:

```bash
pi install git:github.com/zhcsyncer/pi-extensions
```

Try without installing:

```bash
pi -e git:github.com/zhcsyncer/pi-extensions
```

Install from npm:

```bash
pi install npm:@zhcsyncer/pi-recap
```

Local development:

```bash
pi -e ./packages/pi-recap
```

### Commands

```text
/recap
```

Generate a recent activity recap. It will:

1. collect recent activity since the previous recap;
2. call a model to generate a one-line recap;
3. generate a short title;
4. persist state with `pi.appendEntry("recap", ...)`;
5. display the recap in an editor widget;
6. optionally apply the title to the Pi session name;
7. optionally sync the session name to the nearest Herdr pane or tmux window.

```text
/recap-config
```

Open the TUI config screen. `/recap` is always available; auto recap is the background switch. It saves to:

```text
$PI_CODING_AGENT_DIR/extension-data/pi-recap/config.json
```

The model list starts with `current` (the session model), then currently enabled models. A configured model that is not in that list still shows, and opening the picker does not change it. While the model is `current`, fallback is hidden and left unchanged. If you pick a specific model that later cannot be resolved and fallback is on, recap warns once and uses the session model. A cheaper dedicated recap model is recommended.

```text
/recap-config json
```

Edit the JSON config. This is optional; the TUI covers the remaining settings, including a custom idle wait and language.

### TUI only

recap only runs in Pi TUI mode. Headless modes such as `print`, `json`, and `rpc` are skipped to avoid extra model calls, session writes, or naming side effects in scripts and multi-instance environments.

### Config files

The extension reads:

```text
$PI_CODING_AGENT_DIR/extension-data/pi-recap/config.json
.pi/extension-data/pi-recap/config.json
```

Project-local `.pi/extension-data/pi-recap/config.json` is read only when the project is trusted, and it overrides global config. On first load, the previous global and trusted-project paths are automatically migrated and upgraded; unmappable fields are dropped with a warning, and malformed files are preserved.

See example config:

```text
examples/recap.json
```

Default config:

```json
{
  "recap": {
    "auto": true,
    "idleAfterTurnMs": 180000,
    "model": "current",
    "fallbackToCurrentModel": true,
    "language": "auto"
  },
  "title": {
    "applyPolicy": "off"
  },
  "multiplexer": {
    "enabled": true,
    "template": "π {session} · {project}"
  }
}
```

### Common config

Apply generated titles to Pi session names:

```json
{
  "title": {
    "applyPolicy": "if-empty-or-auto"
  }
}
```

Titles are always generated. If the model omits a usable title, recap deterministically uses the cleaned one-line recap as the title. `off` does not change the Pi session name. `if-empty` fills a blank name only. `if-empty-or-auto` also updates a name recap last wrote, without overwriting a later manual name. `always` overwrites. The persisted recap records that the title came from the fallback, so the editor widget shows the warning after generation and after a session reload.

Plain text and ordinary bullet recap responses remain valid. Empty recaps, malformed or truncated JSON-like responses, and completions stopped with `length` or `error` are treated as failed recaps: the widget shows the failure, no recap entry is appended, the session is not renamed, and the previous recap source position is preserved.

Disable automatic recap and keep manual `/recap` only:

```json
{
  "recap": {
    "auto": false
  }
}
```

Use a specific recap model in `/recap-config`, or in JSON:

```json
{
  "recap": {
    "model": "google/gemini-2.5-flash",
    "fallbackToCurrentModel": true
  }
}
```

Recap display always uses an editor widget above the editor. Automatic recap progress is replaced by the result in that widget. Manual `/recap` uses a cancellable loader while generating, then shows the result in the widget. The widget is cleared when the next message starts. If an automatic recap is still running, it is cancelled and cannot later store or redisplay a stale result.

When an older config is loaded, removed fields such as `enabled`, `manualCommand`, `title.generate`, `title.applyToSessionName`, and `display` are dropped and the source config file is updated. A previous `enabled: false` becomes `auto: false`. `applyToSessionName: false` or `applyPolicy: "never"` becomes `applyPolicy: "off"`; other session-name policies are kept. Legacy `tmux` settings are migrated to `multiplexer`; when both exist, explicitly configured `multiplexer` fields take precedence.

Customize the Herdr pane label or tmux window name:

```json
{
  "multiplexer": {
    "template": "π {project} · {session}"
  }
}
```

Supported variables:

```text
{session}
{project}
{cwd}
{id}
```

### Language

`recap.language` defaults to:

```json
{
  "recap": {
    "language": "auto"
  }
}
```

`auto` asks the model to use the same primary language as the recent activity. You can also force a language:

```json
{
  "recap": {
    "language": "zh-CN"
  }
}
```

or:

```json
{
  "recap": {
    "language": "en"
  }
}
```

Note: Pi currently does not expose a user language or locale field to extensions. This is an extension-level setting.

### Terminal multiplexer behavior

When `multiplexer.enabled` is true, recap automatically selects the directly hosting layer:

1. `HERDR_ENV=1` with a non-empty `HERDR_PANE_ID` selects the current Herdr pane label. The `herdr` CLI must be available; Herdr may provide its absolute path through `HERDR_BIN_PATH`.
2. If Herdr is not detected and `TMUX` exists, recap selects the current tmux window name.
3. Otherwise, naming is a no-op.

In nested Herdr-inside-tmux sessions, recap only updates the Herdr pane. If Herdr is detected but its pane identity is incomplete or its CLI is unavailable, recap warns once and does not fall back to the inherited tmux layer.

For tmux, recap keeps the original behavior of disabling `automatic-rename` while it owns the window name. The original pane/window name is restored only if the current name still equals recap's last successful write, so a later manual rename is preserved. Disabling sync or reloading the extension releases ownership immediately; reload always restores before the new extension instance reapplies the name. Ordinary Pi exit also restores the previous name. tmux's captured `automatic-rename` setting is restored whenever owned sync is restored or disabled.

All of these trigger multiplexer sync:

```bash
pi --name "auth refresh"
```

```text
/name auth refresh
```

and recap calling `pi.setSessionName(title)` when enabled by config. Recap does not modify Herdr's Pi agent-state integration.

### Privacy and cost

- Recap makes an extra model call.
- By default it uses the current Pi model: `recap.model = "current"`.
- A cheaper dedicated recap model is recommended if you do not want to spend the session model on this side call.
- Recent activity is sent to the current or configured provider.
- Disable automatic recap if you do not want extra background model calls:

```json
{
  "recap": {
    "auto": false
  }
}
```

### Not compaction

`pi-recap` does not:

- call Pi compact;
- replace LLM history;
- inject recap into future LLM context;
- delete or compress session messages.

Recap history is persisted as extension state with `pi.appendEntry("recap", ...)` and does not participate in LLM context.

### Discoverability in the Pi package gallery

Pi docs state that the package gallery displays packages tagged with the `pi-package` keyword. For public discovery, publish a public npm package and include:

```json
{
  "keywords": ["pi-package"]
}
```

Also include a `pi` manifest:

```json
{
  "pi": {
    "extensions": ["./extensions/recap.ts"]
  }
}
```

Optional gallery preview image:

```json
{
  "pi": {
    "extensions": ["./extensions/recap.ts"],
    "image": "https://example.com/screenshot.png"
  }
}
```

or MP4 video:

```json
{
  "pi": {
    "extensions": ["./extensions/recap.ts"],
    "video": "https://example.com/demo.mp4"
  }
}
```
