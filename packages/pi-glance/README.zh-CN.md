<div align="center">

# ◌ @zhcsyncer/pi-glance

[English](./README.md)

**为 [Pi](https://github.com/earendil-works/pi-mono) 提供安静、可组合的输入界面**

用圆角多行编辑器替换默认输入框，在边框中展示 Git、费用、Reply speed、context、可选 tokens 和模型，同时不隐藏其他扩展发布的状态。

本包是 [`pi-glance`](https://github.com/LinYS77/pi-glance) 0.5.3 的维护 fork，增加 StatusOnly Footer、Follow Pi 主题、右下角 context / 自动压缩详情，以及可开关的 Claude-inspired working indicator。上游 0.5.3 不包含 working indicator。

</div>

---

## 安装

```bash
pi install npm:@zhcsyncer/pi-glance
```

然后重启 Pi 或执行 `/reload`。

需要 Pi 0.80.4 或更新。

## 使用

```text
/glance
/diff
```

`/glance` 打开设置和实时输入界面预览。`/diff` 把终端临时交给可选的 [`revdiff`](https://revdiff.com/) 审阅未提交 Working Tree；annotations 只回填编辑器供你确认，不会自动发送。缺少 revdiff 时，仅 `/diff` 显示安装提示。

## 你会看到什么

![pi-glance demo](./assets/demo.png)

- **圆角编辑器**：最小 2 / 3 / 4 行，顶部 0 / 1 / 2 行间距。
- **工作区标题**：目录名，或安全的 `~/...` 路径。
- **顶部状态**：Git、费用、Reply speed、context、可选 tokens、模型。
- **Working Tree**：文件数和 tracked `+N −N`，在顶栏 Git 或底边右侧。
- **`/glance` 面板**：通用设置、segment 顺序和各项选项。
- **失焦变暗**：滚动聊天时界面变安静。
- **主题**：默认跟随 Pi theme tokens，也可选 22 套 Glance 配色。
- **Working indicator**：spinner、当前活动、本 cycle 输出和耗时。

其他扩展的 `ctx.ui.setStatus()` 仍显示在输入框下方。Glance 不恢复 Pi 那两行信息 Footer。

## 设置

打开 `/glance`：

- **General** — 新安装 `Color source` 为 `Follow Pi`。选 `Glance palette` 使用 22 套内置配色。当前 Pi 主题不可用时，用 `Light palette` / `Dark palette`。`Icons` 默认 `plain`；`nerd` 需要 Nerd Font。图标变成方框就改回 `plain`。`Workspace label` 为 `name`、`smart` 或 `path`。
- **Working indicator** — 一级菜单只有一个 `Enabled: on/off`。`off` 恢复 Pi 默认 working row。
- **Git** — `Dirty marker`（文件计数可见时不亮灯，冲突保留）、`Ahead / behind`、`Behind main`、`SHA`、`Working tree`（`status` 或 `border right`）、`Polling`。
- **Reply speed** — 默认开启。按 output tokens / wall time 显示：`?` 未知，`~42 tok/s` 临时，`42 tok/s` 最终。`Precision` 为 `auto`、1 位或 0 位。wall time 包含 tools、waiting、network 和 thinking，因此不是 benchmark。不发通知、不用 timer、不从文本估算 token。
- **Context** — 百分比 / tokens 文本，可选右下角 `Progress bar`（`track` 或 `border`，`one third` 或 `remaining`）。未用部分细线 `─`，已用部分粗线 `━`。低于 70% 正常，70%（含）到 85%（不含）warning，85% 及以上 error。
- **Bottom details** — 可隐藏自动压缩标记。Nerd Font 显示 `󰁄 auto`。

Git 保持安静：

- 干净仓库只显示分支名。
- 脏仓库加 `*` / `●`；文件计数已可见时不亮灯，例如 `main Δ6 +123 −99`。
- 冲突加 `!` / `⚠`。
- 上游计数形如 `↑2 ↓1`。
- 落后上次拿到的 `origin/main` 时显示高亮 `main↓N`。计数为 0、没有 `origin/main`、或上游 `↓N` 已经在报同一件事时不显示。

`/diff` 是可选的。没有 revdiff 时，Glance 和 Working Tree 概要仍可用。

## Working indicator

**Fork 差异：** 由本包提供；上游 `pi-glance` 0.5.3 不包含该功能。

高层 cycle 活跃时显示主题化 spinner、稳定动词、当前活动、本 cycle 输出和耗时（`47s`、`3m 08s`、`1h 07m`）。五分钟及以上耗时使用主题 warning 色。它不是 Anthropic 官方组件，也不改变 Agent、prompt、模型、工具、消息或 session 行为。

Working row 是当前 cycle 的 output。顶边框 Tokens 是当前 session 累计 usage。Context 是 context window 占用。空 partial 保持隐藏，不显示 `↓ ~0 tokens`。

## 许可证

MIT。原始 `pi-glance` 版权 © 2026 linys77。见 [UPSTREAM_SOURCE.md](./UPSTREAM_SOURCE.md)、[UPSTREAM_LICENSE](./UPSTREAM_LICENSE) 和 [UPSTREAM_README.md](./UPSTREAM_README.md)。
