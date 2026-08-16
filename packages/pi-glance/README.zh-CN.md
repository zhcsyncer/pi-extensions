<div align="center">

# ◌ @zhcsyncer/pi-glance

**为 [Pi](https://github.com/earendil-works/pi-mono) 提供安静、可组合的输入界面**

用圆角多行编辑器替换默认输入框，在边框中展示 Git、费用、回复速率、context、可选 token 和模型信息，同时不再隐藏其他扩展发布的状态。

本包 fork 自 [`pi-glance`](https://github.com/LinYS77/pi-glance) 0.5.3，并在上游输入界面基础上增加固定的 StatusOnlyFooter、Follow Pi 主题集成、输入框右下角 context 与自动压缩详情，以及可关闭、跟随主题的 Claude-inspired working indicator。

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

当前版本面向 `@earendil-works/*` 命名空间、Pi 0.80.4 或更高版本，以及 Node.js 20 或更高版本。最低版本 0.80.4 来自 working indicator cleanup 所依赖的公共 `agent_settled` 生命周期事件。

## 使用

```text
/glance
/diff
```

`/glance` 会打开配置面板和实时输入界面预览。`/diff` 会把终端临时交给可选的 [`revdiff`](https://revdiff.com/) 审阅当前未提交 Working Tree；annotations 只回填到 Pi 编辑器，等待你确认或修改，不会自动发送给 Agent。

## 你会看到什么

- **圆角编辑器**：可配置最小 2 / 3 / 4 行和顶部 0 / 1 / 2 行间距，并保留 Pi 原生自动补全、粘贴和滚动能力。
- **工作区标题**：展示目录名，或安全缩短后的 `~/...` 路径。
- **顶部状态**：Git、费用、Reply speed、context、可选 tokens 和模型。
- **Working Tree 概要**：按唯一当前路径统计文件数，并显示 tracked `+N −N`；默认并进顶栏 Git，也可钉在底边右侧。
- **可组合 Footer**：只渲染其他扩展通过 `ctx.ui.setStatus()` 发布的状态，不再将其全部隐藏。
- **固定省略 Pi 状态行**：不再重建被 Glance 输入界面替代的两行 workspace/usage/context/model 信息，也不提供启用开关。
- **右下角详情**：固定启用，仅展示可选的 context 进度条和高亮自动压缩标记。
- **Git 增强**：dirty、冲突、上游 ahead/behind、相对 `origin/main` 的 `main↓N` 和可选 SHA。
- **主题**：新安装默认跟随 Pi theme tokens，也可选择 22 套 Glance 内置配色；不会切换或安装 Pi 主题。
- **Working indicator**：Claude-inspired 星形动画、shimmer、当前活动、本 cycle 输出 token 与耗时，并自动适配窄终端。

## 说明

- 普通终端字体默认使用 `plain` 图标；`nerd` 图标需要 Nerd Font 或 Symbols Nerd Font fallback。
- 其他扩展的 `ctx.ui.setStatus()` 状态默认保留在输入框下方。
- 新安装默认把 Working Tree 计数放进顶栏 Git，例如 `main Δ6 +123 −99`。这些计数可见时顶栏不再亮脏灯。进入 `/glance` → **Git** → `Working tree` 可在 `status`（默认）和 `border right` 之间切换。
- 文件数覆盖 staged、unstaged、conflict、untracked，并按当前路径去重。`+N −N` 使用 tracked Working Tree 相对 `HEAD` 的标准统计；binary、失败或超时时省略无法可靠计算的统计，轮询不会读取 untracked 文件内容。
- 聚焦输入框的普通边框使用所选 Color source，不再跟随 thinking level。Bash 是唯一动态例外：`!` 使用该颜色来源的 Bash 色并显示 `Bash`，`!!` 显示 `Bash · no context`。
- 长输入最大高度、内部滚动、`↑/↓ N more`、自动补全和大段粘贴 marker 都继续使用 Pi 原生行为。
- Reply speed 默认启用：`? tok/s` 表示未知，`~42 tok/s` 表示当前 agent run 的临时值，`42 tok/s` 表示 `agent_end` 后的最终值。
- Reply speed 使用 output tokens / wall time；wall time 包含 thinking、网络等待、工具执行和 provider 排队，因此不是纯模型解码 benchmark。
- Reply speed 不从流式文本估算 token，也不运行自己的刷新 ticker。
- Claude-inspired working indicator 是 Glance 组件，不是 Anthropic 官方组件，也不承诺逐像素兼容。它只使用 Pi 公共显示与生命周期 API，不改变 Agent、prompt、模型、工具、消息或 session 行为，也不会弹完成通知或增加 transcript 行。
- `/glance` 会在一级菜单直接显示 **Working indicator**，其中只有一个 `Enabled: on/off` 开关。`on` 代表完整自动体验；`off` 会停止动画并恢复 Pi 默认 working row。从子列返回时会保留原父项，每个一级项也会记住上次选中的子项。

## Working indicator

**Fork 差异：** Working indicator 由 `@zhcsyncer/pi-glance` 提供；上游 `pi-glance` 0.5.3 不包含该功能。

高层 agent cycle 活跃时，Glance 会接管 Pi working row，自动显示主题化往返星形 spinner、当前 cycle 内保持稳定的趣味动词、requesting/thinking/tool 活动、可用的 thinking effort、本 cycle 输出 token 和耗时。并行工具独立跟踪；retry、压缩重试和 queued continuation 会在 `agent_settled` 前保持同一个动词、起始时间和 output 累计。

动画由沉稳的缓动星形和高对比、grapheme-safe 的 accent shimmer 组成，shimmer 中心额外加粗。tool-use 阶段动词保持静态，避免与可见 tool call 争夺注意力。

耗时保持紧凑且易读：`47s`、`3m 08s`、`1h 07m`。不足一分钟使用 dim，一分钟起到五分钟前使用普通文字，五分钟及以上使用主题 warning 色。只强调耗时字段——cycle 很长不代表它已经卡住。

Working output 与另外两类 Glance 指标窗口不同：

- **Working row——当前高层 cycle output。** 已完成 assistant message 使用 provider 上报的 `usage.output`；当前完整 partial assistant message（包括 text、thinking 和已组装的 tool-call arguments）使用 Pi 公共 `estimateTokens()` 做保守估算。流式 burst 由现有 120ms working-row ticker 合并，每帧只估算一次最新完整 partial；空 partial 保持隐藏，不显示 `↓ ~0 tokens`。`↓ ~42 tokens` 表示其中含估算；message finalized 后会用正式 usage 替换估算、移除 `~`，不会双计。
- **顶边框 Tokens——当前 session 累计 usage。** 包含正式 assistant usage，以及嵌套 LLM tool、compaction 和 branch summary usage。
- **Context——当前 context window 占用。** 来自 Pi context-usage API，不等同于任一 output 计数。

窄终端始终优先保留 spinner 与主文案，再依次保留活动、本 cycle token 和耗时；耗时进入 warning 状态后，会优先于 cycle token 保留。输出按 grapheme 与可见列安全处理。只有 responding 已经产生过 generation delta，随后连续 10 秒没有 assistant progress，才使用独立的 stall 色；requesting、thinking 和工具执行不会误报 stall。

Pi working row 是没有 owner stack 的全局单例。同时启用多个同类扩展时，最后写入者生效。关闭该功能或 Glance 时只能恢复 Pi 默认 row，无法恢复另一扩展之前的私有值；settled、shutdown 和 reload 也会执行同样的完整清理。

## 主题与配置

Glance 不是 Pi 主题管理器：不会枚举、切换或安装 Pi UI 主题。`colorSource` 为 `pi` 时，它只读取当前公开 Pi theme 并使用语义 token。

新安装默认配置：

```json
{
  "workingIndicator": {
    "enabled": true
  },
  "git": {
    "worktreeSummary": "status"
  },
  "colorSource": "pi",
  "theme": {
    "light": "light",
    "dark": "dark"
  }
}
```

`Follow Pi` 会把输入框、文本、状态、warning、error、标题、详情和 working indicator 映射到 Pi semantic theme tokens，并响应运行时主题切换。普通边框使用 Pi `border` token，不使用 thinking level 边框；只有 Bash 使用 Pi `bashMode` token。

选择 `Glance palette` 时，普通边框、segments、context 进度和 working indicator 都使用当前 light/dark 内置配色；Bash 使用该 palette 的 warning 色。当前 Pi theme 不可用时也以它作为 fallback。22 套配色包括 Light/Dark、Catppuccin、Nord、Tokyo Night、Gruvbox、Solarized、Rosé Pine、One、Kanagawa、Everforest 和 High Contrast 变体。

迁移保持保守：schema 14 及更早的 above/left 档会变成 `git.worktreeSummary: "status"`；schema 10 及更早配置若缺少 `colorSource`，会使用 `colorSource: "glance"`，保留原有视觉；显式配置的新字段会保留。旧字符串主题仍会迁移到相同的 light/dark 槽。

## Segment 详情

- **Git**：dirty、冲突、上游 ahead/behind、落后 main 的 `main↓N`、SHA、Working Tree 计数（顶栏或底边右侧）和轮询。
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

输入框右下角详情固定启用，没有总开关，并且可以包含：

- **Working Tree**：`status`（默认）把计数放进顶栏 Git。`border-right` 把同一份响应式概要钉在底边最右侧。候选依次降级为 `Δ 6 files · +123 −99` → `Δ 6 · +123 −99` → `Δ 6`；冲突优先保留，clean 在窄屏最先隐藏。`border-right` 与 context `remaining` 同时使用时，Git 固定在最右侧，context progress 使用左侧剩余空间，并随着占用增长向左延伸。
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

配置保存在 `$PI_CODING_AGENT_DIR/extension-data/pi-glance/config.json`。当前 schema 为版本 15；旧路径与旧 schema 会自动迁移升级，无法映射的字段会被丢弃并提示 warning，格式损坏的文件会原样保留。Pi Header 始终由 Pi 原生负责，同时继续丢弃已废弃的 Footer 和详情开关。

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

## Git 状态与 Working Tree review

Git 信息异步采集并缓存，渲染阶段不执行 IO。状态使用 NUL 分隔的稳定 porcelain v2 输出，tracked 行统计独立使用 Working Tree 相对 `HEAD` 的 numstat：

```bash
git --no-optional-locks status --porcelain=v2 --branch --show-stash -z
```

可在 `/glance` → **Git** 中配置：

- `Dirty marker`：文件计数还没出现时显示/隐藏脏灯；冲突始终保留。
- `Ahead / behind`：上游 ahead/behind 计数。
- `Behind main`：当前分支落后 `origin/main` 时显示 `main↓N`。
- `SHA`：`off`、`detached`、`always`。
- `Working tree`：`status`（默认）或 `border right`。
- `Polling`：`5s`、`15s`（默认）、`30s`、`60s`。

`status` 只在 dirty/conflict 时把唯一文件数和 tracked `+N −N` 并进现有 Git segment，例如 `main Δ6 +123 −99`。这些计数可见时不再亮脏灯。clean 仓库仍然只显示分支名。`border right` 把同一份紧凑概要移到底边右侧，顶栏也不再亮脏灯；冲突标记仍保留。

刷新以事件驱动为主：session 启动和 cwd 变化立即刷新；edit/write/bash 与未知自定义工具完成后使用 250ms trailing debounce；明确只读工具跳过；`agent_settled` 再校准。兜底轮询默认 15 秒，禁止重叠并在失败/慢场景安全退避。5 秒 status 轮询不会 `git fetch`；`origin/main` 只在 session 开始、编辑器回到前台，或本地快照超过约 12 分钟时后台更新。`main↓N` 始终相对上次已拿到的本地 `origin/main`。不会安装递归文件 watcher。

`/diff` 会直接在仓库 cwd 运行 revdiff 默认的 uncommitted review。Glance 先停止 Pi TUI、完成 terminal handoff，再启动 TUI；退出、取消和错误路径都会清理临时 annotations 并立即刷新概要。有 annotations 时只回填编辑器供用户确认，不自动发送给 Agent。缺少 revdiff 时，仅 `/diff` 显示安装提示（`brew install umputun/apps/revdiff` 或设置 `REVDIFF_BIN`），不会禁用 Glance 或概要；非 TUI 模式会安全拒绝 terminal handoff。

## 设计

- 仅使用 Pi 公共扩展 API，不修改 Pi core。
- `StatusOnlyFooter` 使用公开的 `footerData.getExtensionStatuses()` 保留扩展状态。
- Git 在后台异步缓存；Pi settings 只在生命周期刷新时读取，不在渲染阶段读取；Glance 只维护一个内存 working-message timer，已安装 spinner frames 的动画由 Pi 公共 UI API 驱动。
- 自定义编辑器继承 `CustomEditor`，保留 Pi 快捷键、自动补全、粘贴、最大高度和滚动行为。
- pi-glance 不替换 Pi 原生 Header 或资源区；Context、Skills、Prompts、Extensions 继续由 Pi 负责概要、层级和展开。Extensions 展开后仍按 project/user/path 分组，并由 Pi 显示 `npm:`/`git:` 包来源和本地文件路径。

## 许可证与上游归属

MIT。原始 `pi-glance` 版权 © 2026 linys77。准确 fork 来源和保留材料见 [UPSTREAM_SOURCE.md](./UPSTREAM_SOURCE.md)、[UPSTREAM_LICENSE](./UPSTREAM_LICENSE) 和 [UPSTREAM_README.md](./UPSTREAM_README.md)。
