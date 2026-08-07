# pi-todo

[English](./README.md)

面向 Pi 的 Todo 扩展，维护自 `@juicesharp/rpiv-todo`。它注册 `todo` 工具、`/todo` 视觉设置命令以及持久化任务浮层，可独立安装，也包含在 `@zhcsyncer/pi-extensions` 聚合包中。

该 fork 有意不接入工具 intent。成功的 Todo 调用默认在 TUI transcript 中渲染为零行，由持久化 widget 展示当前状态；按 `Ctrl+O` 展开工具输出时可查看紧凑调用与结果摘要，执行错误始终显示。工具的 `content` 与版本化状态 `details` 保持在 session 中，模型反馈、分支恢复和 reload 后重建不受影响。

## 安装

只安装 Todo 扩展：

```bash
pi install npm:@zhcsyncer/pi-todo
```

也可以从仓库安装完整扩展集合：

```bash
pi install git:github.com/zhcsyncer/pi-extensions
```

## 使用原则与状态契约

- 单步骤、低风险工作直接执行，不创建 Todo；Todo 只表示有独立完成价值的多阶段里程碑。
- 正常状态流转为 `pending → in_progress → completed`；已完成但未及时更新状态的 pending 任务可直接补记为 completed，遇到独立 blocker 时也可把进行中任务重新排回 pending。
- create 默认生成 pending，也可通过 `status: "in_progress"` 直接启动；任务定位由 `subject` 和可选 `description` 表达，不需要额外的活动文案字段。
- 同时只能有一个 `in_progress`；依赖未全部完成的任务不能开始或完成。
- `batch` 按数组顺序执行多条 create/update/delete，任一操作失败则整体回滚。任务交接必须先完成或 re-queue 当前活动任务，再启动下一项。

初始列表可在一次 batch 中同时创建并启动首项：

```json
{
  "action": "batch",
  "operations": [
    { "action": "create", "subject": "研究现状", "status": "in_progress" },
    { "action": "create", "subject": "实现改动" },
    { "action": "create", "subject": "验证结果" }
  ]
}
```

已有列表的原子交接应保持操作顺序：

```json
{
  "action": "batch",
  "operations": [
    { "action": "update", "id": 1, "status": "completed" },
    { "action": "update", "id": 2, "status": "in_progress" }
  ]
}
```

## 视觉设置与 JSON 配置

在 TUI 模式中运行 `/todo`，可配置用户可见的 `statusIcons` 与 `maxWidgetLines`。变更会原子保存到 canonical 配置文件，并立即应用到当前 widget。其他 Pi 模式会给出清晰错误，不会尝试打开不受支持的自定义 UI。

全局配置位于：

```text
$PI_CODING_AGENT_DIR/extension-data/pi-todo/config.json
```

Pi 默认 agent 目录下对应 `~/.pi/agent/extension-data/pi-todo/config.json`。首次读取时，已有的 `$XDG_CONFIG_HOME/rpiv-todo/config.json`（通常是 `~/.config/rpiv-todo/config.json`）会原子迁移。canonical 文件始终优先；格式损坏、不可读或与 canonical 冲突的旧文件会保留并给出 warning，不会被覆盖或静默删除。

也可以直接通过 JSON 编辑相同的视觉设置：

```json
{
  "statusIcons": "ascii",
  "maxWidgetLines": 13
}
```

`maxWidgetLines` 限制 widget 的实际高度，标题、任务行、溢出摘要和末尾空白分隔行均计入。默认值仍为 13 行。有限数值会向下取整且至少为 4；无效值回退到 13。JSON 接受任意有限整数；`/todo` 提供一组实用预设，并保留已从 JSON 加载的合法自定义值。

| 预设 | 标题 | pending | in_progress | completed | 说明 |
| --- | --- | --- | --- | --- | --- |
| `ascii`（默认） | `[T]` | `[ ]` | `[>]` | `[x]` | 固定 ASCII 字宽，跨终端最稳定 |
| `unicode` | `≡` | `○` | `◉` | `✓` | 紧凑的标准 Unicode 字符 |
| `nerd-font` | `󰝖` | `󰄰` | `󰪞`…`󰪥` | `󰗠` | 需要 Nerd Font；仅任务行的进行中图标以 300ms 间隔动画显示 |

标题始终使用独立的静态 Todo 图标。状态图标使用 Pi 当前主题的语义色：pending 为 `dim`、in_progress 为 `accent`、completed 为 `success`。任务文本进一步区分层级：pending 为 `muted`、in_progress 为 `accent` 加粗、completed 为 `dim` 加删除线；任务 ID 仅在进行中使用 `accent`，其余状态为 `dim`。Nerd Font 的进行中帧以 300ms 间隔动画显示，并在预设切换后立即正确响应。

widget 超限时，入选优先级依次为 `in_progress`、`pending`、`completed`；同一状态内保持原顺序，最终入选行仍按任务自然顺序渲染。摘要会准确报告被隐藏的 pending 和 completed 数量。

同一 JSON 文件还可通过 `guidance.promptSnippet` 和 `guidance.promptGuidelines` 覆盖面向模型的 Todo guidance。这些字段会改变模型系统提示，并非视觉设置，因此有意只支持 JSON 配置。无效图标或 guidance 值继续沿用原有回退行为。

旧 session 快照中的 `activeForm` 仍可读取，但 replay 时会忽略该废弃字段；新 schema 和新快照不再包含它。

## 来源

- 上游：[`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)
- 基线：`v1.20.0` / `060373d9292aeb46aeedc23a6d818a997200a6e5`
- 保留的上游文档：[`UPSTREAM_README.md`](./UPSTREAM_README.md)
- 保留的上游版本历史：[`UPSTREAM_CHANGELOG.md`](./UPSTREAM_CHANGELOG.md)

该包作为 `@zhcsyncer/pi-todo` 独立发布；根 bundle 同时包含相同实现。

## 展示与持久化

- `renderShell: "self"` 默认隐藏成功节点，展开模式提供可审计摘要，避免与 widget 重复展示。
- reducer 校验失败会抛出真正的 Pi 工具错误；执行错误始终可见。
- 每个 tool result 的 `details` 保存带 schema version 的 `tasks` 与 `nextId` 快照。
- `session_start`、`session_tree` 和 `session_compact` 从当前 branch 最后的有效 Todo 快照恢复状态。
- 每个扩展 runtime 持有独立 store，同一 Node.js 进程中的多个 SDK `AgentSession` 不会串状态。
- 原始 tool call/result 仍保存在 session 中；默认隐藏只影响 TUI。
- 任务历史仍属于 session 状态；只有用户可编辑的展示与 guidance 配置迁入 `extension-data/pi-todo/config.json`。

## 开发

```bash
pnpm --filter @zhcsyncer/pi-todo check
pi --no-extensions -e ./packages/pi-todo --list-models __pi_todo_check__
```

## 许可证

MIT。参见 [`LICENSE`](./LICENSE) 和 [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE)。
