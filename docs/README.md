# 仓库内部方案

这里只放代码、测试、git 恢复不了的东西：Why、产品意图、心智模型、约定红线、非显然外部事实。用户可见的安装与用法仍在各包 `README.md` / `README.zh-CN.md`。

横切方案放根下；包或 provider 特有方案按目录切片。

| 文档 | 状态 | 讲什么 |
|---|---|---|
| [extension-data-layout.md](./extension-data-layout.md) | 已落地 | 扩展配置与内部状态的统一路径、trust 边界 |
| [tui-design-system.md](./tui-design-system.md) | 参考 | Claude Code 风格 TUI 色板与 chrome |
| [pi-glance/input-stash.md](./pi-glance/input-stash.md) | 已落地 | 输入框单槽暂存：快捷键、边框提示、按 session 覆盖写 |
| [pi-glance/working-indicator.md](./pi-glance/working-indicator.md) | 已落地 | Glance working row 的显示边界与主题跟随 |
| [pi-meter/extension.md](./pi-meter/extension.md) | 已落地 | 本地账本与订阅剩余两套账 |
| [pi-fast-mode/extension.md](./pi-fast-mode/extension.md) | 已落地 | 同模型 Fast / Priority：内存开关、loader 红线 |
| [pi-herdr-companion/extension.md](./pi-herdr-companion/extension.md) | 已落地 | Herdr 可见进程、临时 `/btw`、blocked；worker 实现保留但不注册 |
| [pi-tool-display-intent/aggregate-layout.md](./pi-tool-display-intent/aggregate-layout.md) | 已落地 | aggregate Tools 账本：按请求汇总、不改执行与历史 |
| [pi-todo/active-plan-lifecycle.md](./pi-todo/active-plan-lifecycle.md) | 已落地 | Todo 有界周期与 checkpoint 收缩 |
| [pi-subagents/background-duplication.md](./pi-subagents/background-duplication.md) | 已落地 | 后台委派重复工作的根因与修复边界 |
| [pi-plan-mode/plan-lifecycle.md](./pi-plan-mode/plan-lifecycle.md) | 已落地 | Plan 文档评审与工作生命周期正交 |
| [pi-plan-mode/submit-plan-tool-display.md](./pi-plan-mode/submit-plan-tool-display.md) | 已落地 | `submit_plan` 的 TUI 投影 |
| [providers/pi-provider-volcengine-agent-plan/quota-auto-refresh.md](./providers/pi-provider-volcengine-agent-plan/quota-auto-refresh.md) | 未实现 | 火山套餐余量与 tier 自动刷新 |

包内 `packages/*/docs/` 只保留用户可见说明（如 Ask User Question 的配置/键盘文档）。方案不再散落在仓库根或包 `docs/`。
