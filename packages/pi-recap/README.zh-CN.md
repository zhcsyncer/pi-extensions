# pi-recap

[English](./README.md)

`pi-recap` 是一个 Pi extension，用来生成**最近活动 recap**。它不是 compact，不会压缩或替换 LLM 上下文。

核心能力：

- 手动 `/recap` 生成最近活动摘要；
- agent 完成后空闲一段时间自动生成 recap；
- 发送新消息时取消尚未完成的自动 recap，避免写入或展示过期结果；
- 使用互斥的 footer status 或 editor widget 展示 recap；
- recap 时顺便生成短 title；
- 是否用 title 更新 Pi session name 由配置控制；
- session name 变化时可选同步 tmux window name；
- `/recap-config` 提供 TUI 常用配置；
- `/recap-config json` 编辑完整 JSON 配置。

### 安装

从 Git 安装整个 `zhcsyncer/pi-extensions` bundle：

```bash
pi install git:github.com/zhcsyncer/pi-extensions@v0.1.2
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

### TUI only

recap 只在 Pi TUI 模式工作。`print`、`json`、`rpc` 等 headless 模式会直接跳过，避免后台脚本或多实例场景产生额外模型调用、session 写入或命名副作用。

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
    "model": "current",
    "fallbackToCurrentModel": true,
    "maxRecentChars": 20000,
    "maxTokens": 300,
    "language": "auto"
  },
  "display": {
    "notify": true,
    "mode": "status",
    "widgetPlacement": "aboveEditor"
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

切换为 widget 展示：

```json
{
  "display": {
    "mode": "widget",
    "widgetPlacement": "aboveEditor"
  }
}
```

`display.mode` 可选 `"status"` 或 `"widget"`。两种模式互斥：生成中的提示和最终 recap 都只使用当前模式。status 或 widget 会在下一条消息开始时清除；如果自动 recap 仍在生成，该任务也会被取消，并且不会在稍后写入或重新展示过期结果。

旧配置中的 `display.widget: true/false` 会在读取时自动迁移为 `display.mode: "widget"/"status"`；`clearWidgetOnNextAgentStart` 已不再需要。

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
