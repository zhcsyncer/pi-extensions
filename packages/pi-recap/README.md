# pi-recap

[中文文档](./README.zh-CN.md)

`pi-recap` is a Pi extension that generates a **recent activity recap**. It is not compaction and does not replace or shrink the LLM context.

Features:

- Generate a recent activity recap with `/recap`.
- Automatically recap after the agent has been idle for a while.
- Generate a short title as a recap side effect.
- Optionally apply the title to the Pi session name.
- Optionally sync Pi session name changes to the current tmux window name.
- Configure common options with `/recap-config`.
- Edit full JSON config with `/recap-config json`.

### Installation

Install the whole `zhcsyncer/pi-extensions` bundle from Git:

```bash
pi install git:github.com/zhcsyncer/pi-extensions@v0.1.2
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
5. display the recap according to config;
6. optionally apply the title to the Pi session name;
7. optionally sync the session name to the current tmux window.

```text
/recap-config
```

Open the TUI config screen and save common settings to:

```text
~/.pi/agent/recap.json
```

```text
/recap-config json
```

Edit the full JSON config.

### TUI only

recap only runs in Pi TUI mode. Headless modes such as `print`, `json`, and `rpc` are skipped to avoid extra model calls, session writes, or naming side effects in scripts and multi-instance environments.

### Config files

The extension reads:

```text
~/.pi/agent/recap.json
.pi/recap.json
```

Project-local `.pi/recap.json` is read only when the project is trusted, and it overrides global config.

See example config:

```text
examples/recap.json
```

Default config:

```json
{
  "recap": {
    "enabled": true,
    "auto": true,
    "manualCommand": true,
    "idleAfterTurnMs": 180000,
    "minSessionTurns": 3,
    "neverTwiceInARow": true,
    "model": "current",
    "fallbackToCurrentModel": true,
    "maxRecentChars": 20000,
    "maxTokens": 300,
    "language": "auto"
  },
  "display": {
    "notify": true,
    "widget": false,
    "widgetPlacement": "aboveEditor",
    "clearWidgetOnNextAgentStart": true
  },
  "title": {
    "generate": true,
    "applyToSessionName": false,
    "applyPolicy": "if-empty-or-auto",
    "maxLength": 50
  },
  "tmux": {
    "enabled": true,
    "template": "π {session} · {project}",
    "maxLength": 48,
    "restoreOnShutdown": true
  }
}
```

### Common config

Apply generated titles to Pi session names:

```json
{
  "title": {
    "applyToSessionName": true,
    "applyPolicy": "if-empty-or-auto"
  }
}
```

Disable automatic recap and keep manual `/recap` only:

```json
{
  "recap": {
    "auto": false
  }
}
```

Use a specific recap model:

```json
{
  "recap": {
    "model": "google/gemini-2.5-flash",
    "fallbackToCurrentModel": true
  }
}
```

Enable widget display:

```json
{
  "display": {
    "widget": true,
    "widgetPlacement": "aboveEditor"
  }
}
```

Customize tmux window name:

```json
{
  "tmux": {
    "template": "π {project} · {session}",
    "maxLength": 60
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

### tmux behavior

When `tmux.enabled` is true:

- It only runs when `process.env.TMUX` exists.
- It disables `automatic-rename` for the current tmux window to avoid shell-command overwrites.
- It renames the current tmux window when Pi session name changes.
- If `restoreOnShutdown` is true, it restores the previous window name and `automatic-rename` setting when Pi exits.

All of these trigger tmux sync:

```bash
pi --name "auth refresh"
```

```text
/name auth refresh
```

and recap calling `pi.setSessionName(title)` when enabled by config.

### Privacy and cost

- Recap makes an extra model call.
- By default it uses the current Pi model: `recap.model = "current"`.
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
