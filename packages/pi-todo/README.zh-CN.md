# pi-todo

[English](./README.md)

面向 Pi 的 Todo 扩展，维护自 `@juicesharp/rpiv-todo`。它注册 `todo` 工具、`/todo` 设置与 reset 命令以及持久化任务浮层，可独立安装，也包含在 `@zhcsyncer/pi-extensions` 聚合包中。

该 fork 有意不接入工具 intent。成功的 Todo 调用默认在 TUI transcript 中渲染为零行，由持久化 widget 展示当前状态；按 `Ctrl+O` 展开工具输出时可查看紧凑调用与结果摘要，执行错误始终显示。工具 `content`、mutation checkpoint 与用户 reset checkpoint 保持在 session 中，用于模型反馈和 branch-aware 恢复；只读 query 的轻量 details 不再重复保存任务状态。

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

- 仅当初始计划至少包含两个有独立完成价值的里程碑时才使用 Todo。只有一个里程碑的工作直接执行，风险、耗时、重要性或预计工具调用数量都不能例外。只拆分确有不同结果的工作；不得把紧密的 edit-test 循环拆开或制造填充项来凑够两项。
- Todo 是有界、有序的当前执行焦点，用于在上下文膨胀、compact、resume 和 tree 切换后帮助模型不跑偏。它不是设计文档、执行日志、依赖图或长期审计记录；长期决策与证据应留在独立文档和 transcript 中。
- 正常状态流转为 `pending → in_progress → completed`；已完成但未及时更新状态的 pending 任务可直接补记为 completed，遇到独立插入工作时也可把进行中任务重新排回 pending。
- create 默认生成 pending，也可通过 `status: "in_progress"` 直接启动；任务定位由 `subject` 和可选 `description` 表达，不需要额外的活动文案字段。
- 同时只能有一个 `in_progress`；初始 batch 顺序是默认串行顺序，后来出现的插入工作临时改变顺序时，以 `in_progress` 作为权威即时焦点。
- 每个新周期必须用一次原子 `batch` 按执行顺序启动，其中至少包含两条 create：第一项为 in_progress，其余为 pending。不得用顶层 create 或单项 batch 启动周期；顶层 create 只用于向已有活动多任务周期末尾追加后来发现的里程碑。
- 其他任务完成后，周期中可能只剩一项未完成或可见任务；这是正常状态，不应为维持数量添加填充项。
- `batch` 按数组顺序执行多条 create/update/delete，任一操作失败则整体回滚。独立工作打断当前里程碑时，可原子地把当前任务重新排回 pending，并创建插入任务为 in_progress；插入任务完成后再恢复原任务。
- 当前所有任务均已 completed/deleted 后，应使用规定的多 create batch 开启下一周期；runtime 会在该 batch 前自动 rollover。旧周期任务会离开 live state，只能从 transcript/tree 查看。空状态或刚做完一轮时，顶层 create 和只有一条 create 的 batch 会被拒绝。
- 整个 session tree 内的任务 ID 保持单调：rollover 和用户 reset 都保留 `nextId`，branch replay 也会维持 session 级高水位，不会复用旧 ID。
- 默认 `list` 只返回 pending/in-progress，并报告隐藏了多少 completed；没有 status filter 时，`includeDeleted: true` 返回当前 live state 的所有状态；显式 `status` filter 可直接查询 completed/deleted。

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

## 视觉设置、Reset 与 JSON 配置

在 TUI 模式中运行 `/todo`，可配置用户可见的 `statusIcons`、`maxWidgetLines`，也可选择 **Reset current todos**。Reset 会先显示将移除的任务数量；若仍有 pending/in-progress，会额外警告，并默认停留在取消选项。确认后写入 branch-scoped checkpoint、立即清空 widget，同时保留 `nextId`，后续不会复用任务 ID。其他 Pi 模式会给出清晰错误，不会尝试打开不受支持的自定义 UI。

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

标题始终使用独立的静态 Todo 图标。状态图标使用 Pi 当前主题的语义色：pending 为 `dim`、in_progress 为 `accent`、completed 为 `success`。任务文本进一步区分层级：pending 为 `muted`、in_progress 为 `accent` 加粗、completed 为 `dim` 加删除线。Nerd Font 的进行中帧以 300ms 间隔动画显示，并在预设切换后立即正确响应。

widget 超限时，入选优先级依次为 `in_progress`、`pending`、`completed`；同一状态内保持原顺序，最终入选行仍按任务自然顺序渲染。摘要会准确报告被隐藏的 pending 和 completed 数量。

同一 JSON 文件还可通过 `guidance.promptSnippet` 和 `guidance.promptGuidelines` 覆盖面向模型的 Todo guidance。这些字段会改变模型系统提示，并非视觉设置，因此有意只支持 JSON 配置。无效图标或 guidance 值继续沿用原有回退行为。

旧 V1/V2 session 快照可能仍含 `activeForm`、依赖数据等废弃字段，V1 也可能包含 `action: "clear"` checkpoint。replay 会兼容读取这些历史快照，只保留当前任务字段，并在需要时初始化 V2 新增状态字段。当前面向模型的 schema 不再暴露 `clear` 或任何依赖图字段。

## 来源

- 上游：[`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)
- 基线：`v1.20.0` / `060373d9292aeb46aeedc23a6d818a997200a6e5`
- 保留的上游文档：[`UPSTREAM_README.md`](./UPSTREAM_README.md)
- 保留的上游版本历史：[`UPSTREAM_CHANGELOG.md`](./UPSTREAM_CHANGELOG.md)

该包作为 `@zhcsyncer/pi-todo` 独立发布；根 bundle 同时包含相同实现。

## 展示与持久化

- `renderShell: "self"` 默认隐藏成功节点，展开模式提供可审计摘要，避免与 widget 重复展示。
- reducer 校验失败会抛出真正的 Pi 工具错误；执行错误始终可见。
- 成功 mutation 保存 V2 `kind: "checkpoint"` envelope，其中只包含有界 live state（`tasks`、单调 `nextId`、内部 `generation` 与 `revision`）；`list/get` 只保存很小的 `kind: "query"` envelope，replay 会忽略它。
- 用户确认 reset 以 branch-scoped `pi-todo-state` custom checkpoint 持久化；旧 V1 全量 tool result 保持 replay 兼容。
- `session_start`、`session_tree` 和 `session_compact` 从当前 branch 最后一个合法 mutation/reset checkpoint 恢复；未知或损坏 envelope 会被跳过。
- 每次 agent run 开始时，只要存在活动任务，就在本次 system prompt 尾部追加简短的 `Current Todo state`。若同一 run 中 Todo 随后变化，则在后续 model context 中加入临时的 `Current Todo state update`，避免 overflow compact/retry 重新采用 run 起点的旧快照；两者都不会写成 session entry。内容仅含按自然顺序排列的 active task ID/status/subject 与 completed 数量，不含 description、metadata、deleted 或旧周期任务。
- 每个扩展 runtime 持有独立 store，同一 Node.js 进程中的多个 SDK `AgentSession` 不会串状态。
- 原始 tool call/result 仍保存在 session 中；默认隐藏只影响 TUI。Todo 是有界的当前执行状态，不是 archive；旧周期仍可从 transcript/tree 查看，不会出现在当前 `list/get`。

## 开发

```bash
pnpm --filter @zhcsyncer/pi-todo check
pi --no-extensions -e ./packages/pi-todo --list-models __pi_todo_check__
```

## 许可证

MIT。参见 [`LICENSE`](./LICENSE) 和 [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE)。
