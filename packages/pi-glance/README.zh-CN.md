<div align="center">

# ◌ @zhcsyncer/pi-glance

**为 [Pi](https://github.com/earendil-works/pi-mono) 提供安静、可组合的输入界面**

用圆角多行编辑器替换默认输入框，在边框中展示 Git、费用、回复速率、context、可选 token 和模型信息，同时不再隐藏其他扩展发布的状态。

本包 fork 自 [`pi-glance`](https://github.com/LinYS77/pi-glance) 0.5.3。它保留上游能力，并增加固定的 StatusOnlyFooter、输入框右下角 context 进度条，以及高亮的自动压缩标记。

[English](./README.md)

</div>

---

## 安装

```bash
pi install npm:@zhcsyncer/pi-glance
```

安装后重启 Pi 或执行 `/reload`。

从本仓库本地开发：

```bash
pi --no-extensions -e ./packages/pi-glance
```

当前版本面向 `@earendil-works/*` 命名空间、Pi 0.80 或更高版本，以及 Node.js 20 或更高版本。

## 使用

```text
/glance
```

该命令会打开配置面板和实时输入界面预览。

## 你会看到什么

- **圆角编辑器**：可配置最小 2 / 3 / 4 行和顶部 0 / 1 / 2 行间距，并保留 Pi 默认编辑器能力。
- **工作区标题**：展示目录名，或安全缩短后的 `~/...` 路径。
- **顶部状态**：Git、费用、Reply speed、context、可选 tokens 和模型。
- **可组合 Footer**：只渲染其他扩展通过 `ctx.ui.setStatus()` 发布的状态，不再将其全部隐藏。
- **固定省略 Pi 状态行**：不再重建被 Glance 输入界面替代的两行 workspace/usage/context/model 信息，也不提供启用开关。
- **右下角详情**：固定启用，仅展示可选的 context 进度条和高亮自动压缩标记。
- **Git 增强**：dirty、冲突、ahead/behind 和可选 SHA。
- **主题**：22 套 Glance 内置配色；不会切换或安装 Pi 主题。

## 说明

- 普通终端字体默认使用 `plain` 图标；`nerd` 图标需要 Nerd Font 或 Symbols Nerd Font fallback。
- 其他扩展的 `ctx.ui.setStatus()` 状态默认保留在输入框下方。
- Reply speed 默认启用：`? tok/s` 表示未知，`~42 tok/s` 表示当前 agent run 的临时值，`42 tok/s` 表示 `agent_end` 后的最终值。
- Reply speed 使用 output tokens / wall time；wall time 包含 thinking、网络等待、工具执行和 provider 排队，因此不是纯模型解码 benchmark。
- 扩展不会从流式文本估算 token，也不会运行刷新 ticker。

## 主题与配置

Glance 使用自己的 22 套内置配色，不是 Pi 主题管理器：不会枚举、切换或安装 Pi UI 主题，也不会直接使用 Pi theme token 颜色。

新配置使用两个主题槽：

```json
{
  "theme": {
    "light": "light",
    "dark": "dark"
  }
}
```

Pi 当前主题名精确为 `light` 时使用 `theme.light`，精确为 `dark` 时使用 `theme.dark`；未知或自定义主题名回退到 `theme.light`。旧字符串主题会保守迁移到两个槽。

## Segment 详情

- **Git**：dirty、冲突、ahead/behind、SHA 和轮询。
- **Cost**：累计费用，可隐藏零费用。
- **Reply speed**：output tokens / wall time，支持自动、1 位或 0 位小数。
- **Context**：百分比、当前 token / context window、右下角独立 track 或底边进度、三分之一或全部剩余宽度，以及压缩后的未知状态。
- **Tokens**：input/output、total、cache read/write；累计口径包括 assistant、嵌套 LLM tool、compaction 和 branch summary usage。
- **Model**：provider、模型名和 thinking level。

## Footer 组合与右下角详情

Glance 已在输入框中展示主要信息，因此 Footer 固定只保留其他扩展发布的状态：

```text
permission strict  recap ready  3 tasks pending
```

Pi 原有的两行 workspace/usage/context/model 信息不再重建，也没有配置开关可以恢复。

输入框右下角详情固定启用，没有总开关，并且只包含：

- **Context progress**：在 `/glance` → **Context** → `Display` 中选择 `progress bar`。`Progress style: track` 保留独立的 `╶───────────╴ 23%`；`Progress style: border` 直接利用输入框底边，未用部分保持细线 `─`，已用部分变为粗线 `━`，并使用 `╼` 连接。`Progress width` 可选择进度与标签合计占内部宽度 `one third`，或使用底边全部 `remaining` 空间。百分比保持普通文本色，底部不显示 context 图标；`nerd` 文本模式仍使用 `󰍛`。
- **Context risk**：低于 70% 时已用部分使用 context 色，70%（含）到 85%（不含）使用 warning，85% 及以上使用 error。顶部 context 文本和两种底部进度样式共用这些固定阈值；未知进度使用 dim 色。
- **Auto compact**：Pi 自动压缩开启时显示。`plain` 模式高亮 `auto`，`nerd` 模式高亮 `󰁄 auto`；可在 **Bottom details** 中单独隐藏。该状态反映 Pi 合并后的全局/项目设置，项目设置仅在项目受信任时读取。

窄终端会优先缩短进度显示；极窄终端中 context 优先于 auto compact。相关配置为：

```json
{
  "context": {
    "display": "progress",
    "unknown": "show",
    "progressStyle": "border",
    "progressWidth": "third"
  },
  "bottomDetails": {
    "showAutoCompact": true
  }
}
```

配置保存在 `~/.pi/agent/pi-glance/config.json`。当前 schema 为版本 10；旧配置会自动迁移并丢弃已废弃的 Footer 和详情开关。

## 工作区标题

在 `/glance` → **General** → `Workspace label` 中选择：

- `name`：只显示当前目录名；
- `smart`：宽终端显示更多安全路径；
- `path`：尽量显示 `~/...` 路径。

Glance 不会在标题中渲染完整绝对路径。Home 路径缩短为 `~/...`，其他路径只保留安全尾部。

## Git 状态

Git 信息异步采集并缓存，渲染阶段不执行 IO：

```bash
git --no-optional-locks status --porcelain=v2 --branch --show-stash
```

可在 `/glance` → **Git** 中配置 dirty、ahead/behind、SHA 和轮询间隔。

## 设计

- 仅使用 Pi 公共扩展 API，不修改 Pi core。
- `StatusOnlyFooter` 使用公开的 `footerData.getExtensionStatuses()` 保留扩展状态。
- Git 在后台异步缓存；Pi settings 只在生命周期刷新时读取，不在渲染阶段读取。
- 自定义编辑器继承 `CustomEditor`，保留 Pi 快捷键和默认编辑行为。

## 许可证与上游归属

MIT。原始 `pi-glance` 版权 © 2026 linys77。准确 fork 来源和保留材料见 [UPSTREAM_SOURCE.md](./UPSTREAM_SOURCE.md)、[UPSTREAM_LICENSE](./UPSTREAM_LICENSE) 和 [UPSTREAM_README.md](./UPSTREAM_README.md)。
