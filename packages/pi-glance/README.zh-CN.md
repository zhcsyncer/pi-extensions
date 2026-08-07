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

- **圆角编辑器**：可配置最小 2 / 3 / 4 行和顶部 0 / 1 / 2 行间距，并保留 Pi 原生自动补全、粘贴和滚动能力。
- **工作区标题**：展示目录名，或安全缩短后的 `~/...` 路径。
- **顶部状态**：Git、费用、Reply speed、context、可选 tokens 和模型。
- **可组合 Footer**：只渲染其他扩展通过 `ctx.ui.setStatus()` 发布的状态，不再将其全部隐藏。
- **固定省略 Pi 状态行**：不再重建被 Glance 输入界面替代的两行 workspace/usage/context/model 信息，也不提供启用开关。
- **右下角详情**：固定启用，仅展示可选的 context 进度条和高亮自动压缩标记。
- **Git 增强**：dirty、冲突、ahead/behind 和可选 SHA。
- **主题**：新安装默认跟随 Pi theme tokens，也可选择 22 套 Glance 内置配色；不会切换或安装 Pi 主题。

## 说明

- 普通终端字体默认使用 `plain` 图标；`nerd` 图标需要 Nerd Font 或 Symbols Nerd Font fallback。
- 其他扩展的 `ctx.ui.setStatus()` 状态默认保留在输入框下方。
- 聚焦输入框的普通边框使用所选 Color source，不再跟随 thinking level。Bash 是唯一动态例外：`!` 使用该颜色来源的 Bash 色并显示 `Bash`，`!!` 显示 `Bash · no context`。
- 长输入最大高度、内部滚动、`↑/↓ N more`、自动补全和大段粘贴 marker 都继续使用 Pi 原生行为。
- Reply speed 默认启用：`? tok/s` 表示未知，`~42 tok/s` 表示当前 agent run 的临时值，`42 tok/s` 表示 `agent_end` 后的最终值。
- Reply speed 使用 output tokens / wall time；wall time 包含 thinking、网络等待、工具执行和 provider 排队，因此不是纯模型解码 benchmark。
- 扩展不会从流式文本估算 token，也不会运行刷新 ticker。

## 主题与配置

Glance 不是 Pi 主题管理器：不会枚举、切换或安装 Pi UI 主题。`colorSource` 为 `pi` 时，它只读取当前公开 Pi theme 并使用语义 token。

新安装默认配置：

```json
{
  "colorSource": "pi",
  "theme": {
    "light": "light",
    "dark": "dark"
  }
}
```

`Follow Pi` 会把输入框、文本、状态、warning、error、标题和详情映射到 Pi semantic theme tokens，并响应运行时主题切换。普通边框使用 Pi `border` token，不使用 thinking level 边框；只有 Bash 使用 Pi `bashMode` token。

选择 `Glance palette` 时，普通边框、segments 和 context 进度都使用当前 light/dark 内置配色；Bash 使用该 palette 的 warning 色。当前 Pi theme 不可用时也以它作为 fallback。22 套配色包括 Light/Dark、Catppuccin、Nord、Tokyo Night、Gruvbox、Solarized、Rosé Pine、One、Kanagawa、Everforest 和 High Contrast 变体。

迁移保持保守：schema 10 及更早配置若缺少 `colorSource`，会使用 `colorSource: "glance"`，保留原有视觉；显式配置的新字段会保留。旧字符串主题仍会迁移到相同的 light/dark 槽。

## Segment 详情

- **Git**：dirty、冲突、ahead/behind、SHA 和轮询。
- **Cost**：累计费用，可隐藏零费用。
- **Reply speed**：output tokens / wall time，支持自动、1 位或 0 位小数。
- **Context**：百分比 / tokens 文本、可选右下角进度条（开启后文本跟随到底部且始终含百分比），以及独立 track 或底边样式、三分之一或全部剩余宽度。
- **Tokens**：input/output、total、cache read/write；累计口径包括 assistant、嵌套 LLM tool、compaction 和 branch summary usage。
- **Model**：provider、模型名和 thinking level。

## Footer 组合与右下角详情

Glance 已在输入框中展示主要信息，因此 Footer 固定只保留其他扩展发布的状态：

```text
permission strict  recap ready  3 tasks pending
```

Pi 原有的两行 workspace/usage/context/model 信息不再重建，也没有配置开关可以恢复。

输入框右下角详情固定启用，没有总开关，并且只包含：

- **Context progress**：在 `/glance` → **Context** 中打开 `Progress bar`。Context 文本会离开顶栏，跟随到底部进度旁；标签始终包含百分比，`Text` 仍可附加 tokens（`percent / tokens`）。`Progress style: track` 保留独立的 `╶───────────╴ 23%`；`Progress style: border` 直接利用输入框底边，未用部分保持细线 `─`，已用部分变为粗线 `━`，并使用 `╼` 连接。`Progress width` 可选择进度与标签合计占内部宽度 `one third`，或使用底边全部 `remaining` 空间。百分比保持普通文本色，底部不显示 context 图标；`nerd` 文本模式仍使用 `󰍛`。
- **Context risk**：低于 70% 时已用部分使用 context 色，70%（含）到 85%（不含）使用 warning，85% 及以上使用 error。顶部 context 文本和两种底部进度样式共用这些固定阈值；填充色和未填充边框都来自当前 Color source，未知进度使用 dim 色。
- **Auto compact**：Pi 自动压缩开启时显示。`plain` 模式高亮 `auto`，`nerd` 模式高亮 `󰁄 auto`；可在 **Bottom details** 中单独隐藏。该状态反映 Pi 合并后的全局/项目设置，项目设置仅在项目受信任时读取。

窄终端会优先缩短进度显示，随后丢弃可选 token 细节并保留百分比；极窄终端中 context 优先于 auto compact。相关配置为：

```json
{
  "context": {
    "text": "percent",
    "progress": true,
    "progressStyle": "border",
    "progressWidth": "third"
  },
  "bottomDetails": {
    "showAutoCompact": true
  }
}
```

配置保存在 `$PI_CODING_AGENT_DIR/extension-data/pi-glance/config.json`。当前 schema 为版本 12；旧路径与旧 schema 会自动迁移升级，无法映射的字段会被丢弃并提示 warning，格式损坏的文件会原样保留。Pi Header 始终由 Pi 原生负责，同时继续丢弃已废弃的 Footer 和详情开关。

## 顶边框优先级

顶边框可以展示两类信息：左侧的工作区标题，以及右侧的动态状态（按启用情况包含 Git、费用、Reply speed、context、可选 tokens 和模型）。

正常编辑时，只要宽度足够，两类信息会同时显示。终端变窄后，动态状态优先获得宽度；工作区标题先在剩余空间中缩短，空间太小时再隐藏。动态状态内部也以 `/glance` 配置的 segment 顺序作为优先级：左侧 segment 优先保留，文案会按需切换为更短形式，再从右端逐项移除，最后才截断单个仍然过长的 segment。

Bash 标签（`Bash` / `Bash · no context`）和编辑器的 `↑ N more` 滚动提示属于更高优先级的交互提示。它们会替代工作区标题并优先占用左侧，动态状态只使用剩余空间。

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
- 自定义编辑器继承 `CustomEditor`，保留 Pi 快捷键、自动补全、粘贴、最大高度和滚动行为。
- pi-glance 不替换 Pi 原生 Header 或资源区；Context、Skills、Prompts、Extensions 继续由 Pi 负责概要、层级和展开。Extensions 展开后仍按 project/user/path 分组，并由 Pi 显示 `npm:`/`git:` 包来源和本地文件路径。

## 许可证与上游归属

MIT。原始 `pi-glance` 版权 © 2026 linys77。准确 fork 来源和保留材料见 [UPSTREAM_SOURCE.md](./UPSTREAM_SOURCE.md)、[UPSTREAM_LICENSE](./UPSTREAM_LICENSE) 和 [UPSTREAM_README.md](./UPSTREAM_README.md)。
