# Glance：Pi 1.1.0 输入与显示适配

状态：G1用量/主题已通过正式离线验收并集成，证据见[执行表G1](../pi-extensions/pi-1.1-execution-plan.md)；真实PTY/Mac仍未验证。归属：[总计划](../pi-1.1-implementation-plan.md) W9；用户已冻结大粘贴 B01，以下 paste 设计与专项测试仅作后续参考。本轮只实施 theme.appearance、必要显示兼容及既有输入/stash 无新增回归；不改变大粘贴行为。用量接入见[Meter 规格](../pi-meter/pi-1.1-quota-plan.md)。

## Goal

本轮复用官方主题语义，保留 working/Git/stash 与既有输入行为。大粘贴立即展示正文是冻结的后续目标，不作为本轮验收或发布条件。

## Design

- 现有 frame 使用 max(minRows, body.length)，minRows 不是固定上限。宿主 1.1 Editor 在超过 10 行或 1000 字符时折叠 paste marker，且有终端视口上限；升级本身不会解决 BACKLOG 体验。
- 在 Glance 输入边界识别并组装完整 bracketed paste；通过公开 insertTextAtCursor 原子插入正文，维持原生布局/滚动和 Glance frame。
- 不依赖私有 handlePaste；不在粘贴后 setText(getExpandedText())，避免重置光标、已有正文或撤销语义。
- 超视口内容应可滚动，不能无限撑高整个终端；普通输入、清空后仍保持原有紧凑行为。
- 使用 theme.appearance 判明暗，把同名 system 主题变化纳入缓存失效。
- 完成工具 durationMs 不代替整轮 working row，也不混入推理速度口径；独立 usage 不进入模型上下文或伪装生成输出。

如果公开插入 API 无法保住宿主编辑/撤销合同，先补可复现证据及必要的宿主输入接点提案；不要用“看起来展开了”降低验收标准。

## Contract / Test Impact（paste 增强用例已冻结；本轮仅主题及原行为回归）

| 档位 / 输入 | 可观察预期 |
|---|---|
| T1：普通单行键入 | 紧凑输入不变，不触发大粘贴路径 |
| T1：10/11 行、1000/1001 字符 | 大粘贴正文直接可编辑，不只显示 marker |
| T1：一次/多块 bracketed paste、中文换行 | 拼接完整，无重复/丢失/中途展开残片 |
| T1：在正文中间粘贴、撤销 | 前后正文与插入点保留，编辑操作语义正确 |
| T1：超视口、清空、stash/reload | 可滚动，清空紧凑；暂存保存正文并可恢复 |
| T1：同名 system 主题切换 | 正确刷新 appearance 缓存，不只按主题名判断 |
| T2：regular/fullscreen、resize、补全、鼠标 | border/status/stash chrome 与坐标正确 |
| T2：Home/End、Ctrl+Home/End、消息导航 | 遵循宿主新版键位，不抢占其他导航行为 |

使用行为与状态用例，不为纯颜色/DOM 结构凑测试。真实输入体验由隔离 TUI 验收；组件 fixture 不能替代整套粘贴/视口检查。
