# pi-recap

[中文](#中文) | [English](#english)

---

## 中文

`pi-recap` 是一个 Pi extension，用来生成**最近活动 recap**。它不是 compact，不会压缩或替换 LLM 上下文。

核心能力：

- 手动 `/recap` 生成最近活动摘要；
- agent 完成后空闲一段时间自动生成 recap；
- recap 时顺便生成短 title；
- 是否用 title 更新 Pi session name 由配置控制；
- session name 变化时可选同步 tmux window name；
- `/recap-config` 提供 TUI 常用配置；
- `/recap-config json` 编辑完整 JSON 配置。

### 安装

从 Git 安装整个 `zhcsyncer/pi-extensions` bundle：

```bash
pi install git:github.com/zhcsyncer/pi-extensions@v0.1.0
```

临时试用：

```bash
pi -e git:github.com/zhcsyncer/pi-extensions
```

从 npm 安装：

```bash
pi install npm:@zhcsyncer/pi-recap
```

本地开发试用：

```bash
pi -e ./packages/pi-recap
```

### 命令

```text
/recap
```

生成最近活动 recap。它会：

1. 收集上一次 recap 之后的最近活动；
2. 调用模型生成一行 recap；
3. 顺便生成一个短 title；
4. 使用 `pi.appendEntry("recap", ...)` 保存状态；
5. 按配置展示 recap；
6. 如果配置允许，用 title 更新 Pi session name；
7. 如果启用 tmux 同步，session name 变化会同步到当前 tmux window。

```text
/recap-config
```

打开 TUI 配置界面，修改常用配置并保存到：

```text
~/.pi/agent/recap.json
```

```text
/recap-config json
```

编辑完整 JSON 配置。

### 配置文件

插件读取：

```text
~/.pi/agent/recap.json
.pi/recap.json
```

项目级 `.pi/recap.json` 仅在项目被 Pi trust 后读取，并覆盖全局配置。

示例配置见：

```text
examples/recap.json
```

默认配置：

```json
{
  "recap": {
    "enabled": true,
    "auto": true,
    "manualCommand": true,
    "idleAfterTurnMs": 180000,
    "minSessionTurns": 3,
    "neverTwiceInARow": true,
    "interactiveOnly": true,
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

### 常用配置

启用自动更新 session name：

```json
{
  "title": {
    "applyToSessionName": true,
    "applyPolicy": "if-empty-or-auto"
  }
}
```

关闭自动 recap，仅保留手动 `/recap`：

```json
{
  "recap": {
    "auto": false
  }
}
```

指定 recap 模型：

```json
{
  "recap": {
    "model": "google/gemini-2.5-flash",
    "fallbackToCurrentModel": true
  }
}
```

启用 widget 展示：

```json
{
  "display": {
    "widget": true,
    "widgetPlacement": "aboveEditor"
  }
}
```

自定义 tmux window 名称：

```json
{
  "tmux": {
    "template": "π {project} · {session}",
    "maxLength": 60
  }
}
```

支持变量：

```text
{session}
{project}
{cwd}
{id}
```

### 语言

`recap.language` 默认是：

```json
{
  "recap": {
    "language": "auto"
  }
}
```

`auto` 会要求模型使用最近活动的主要语言。你也可以显式指定：

```json
{
  "recap": {
    "language": "zh-CN"
  }
}
```

或：

```json
{
  "recap": {
    "language": "en"
  }
}
```

注意：Pi 当前不会向 extension 提供用户语言/locale 字段；这是插件自己的配置。

### tmux 行为

启用 `tmux.enabled` 后：

- 仅在检测到 `process.env.TMUX` 时生效；
- 会关闭当前 tmux window 的 `automatic-rename`，避免被 shell 命令覆盖；
- session name 变化时重命名当前 tmux window；
- `restoreOnShutdown` 为 `true` 时，Pi 退出会恢复原 window name 和 `automatic-rename` 设置。

这些都会触发 tmux 同步：

```bash
pi --name "auth refresh"
```

```text
/name auth refresh
```

以及 recap 根据配置调用 `pi.setSessionName(title)`。

### 隐私与费用

- recap 会额外调用模型。
- 默认使用当前 Pi 模型：`recap.model = "current"`。
- 最近活动内容会发送给当前或配置的 provider。
- 如果不希望自动额外调用模型，请设置：

```json
{
  "recap": {
    "auto": false
  }
}
```

### 不是 compact

`pi-recap` 不会：

- 调用 Pi compact；
- 替换 LLM 历史；
- 把 recap 注入后续 LLM context；
- 删除或压缩 session 消息。

recap 历史使用 `pi.appendEntry("recap", ...)` 作为 extension 状态保存，不参与 LLM context。

### 在 Pi 官方 package gallery 中可见的前提

Pi 文档说明，package gallery 会展示带有 `pi-package` keyword 的包。公开共享时建议：

1. 发布为公开 npm 包；
2. `package.json` 中包含：

```json
{
  "keywords": ["pi-package"]
}
```

3. 提供 `pi` manifest，例如：

```json
{
  "pi": {
    "extensions": ["./extensions/recap.ts"]
  }
}
```

4. 可选添加 gallery 预览图：

```json
{
  "pi": {
    "extensions": ["./extensions/recap.ts"],
    "image": "https://example.com/screenshot.png"
  }
}
```

或 MP4：

```json
{
  "pi": {
    "extensions": ["./extensions/recap.ts"],
    "video": "https://example.com/demo.mp4"
  }
}
```

---

## English

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
pi install git:github.com/zhcsyncer/pi-extensions@v0.1.0
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
    "interactiveOnly": true,
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
