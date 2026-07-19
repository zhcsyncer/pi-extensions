# pi-todo

`@zhcsyncer/pi-extensions` 内置的 Todo 扩展 fork。它注册 `todo` 工具、`/todos` 命令以及持久化任务浮层。

该 fork 有意不接入工具 intent。成功的 Todo 调用在 TUI transcript 中渲染为零行，由持久化 widget 作为唯一的状态展示；执行错误仍会显示。工具的 `content` 与完整状态 `details` 保持不变，模型反馈、session 分支恢复和 reload 后重建不受影响。

## 来源

- 上游：[`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)
- 基线：`v1.20.0` / `060373d9292aeb46aeedc23a6d818a997200a6e5`
- 上游文档：[`UPSTREAM_README.md`](./UPSTREAM_README.md)
- 上游版本历史：[`UPSTREAM_CHANGELOG.md`](./UPSTREAM_CHANGELOG.md)

该包目前作为 workspace 私有包随根 bundle 使用，不单独发布。

## 展示与持久化

- `renderShell: "self"` 配合空成功 renderer，移除重复的 tool call/result 节点。
- reducer 错误及 Pi 执行错误仍以简短错误节点显示。
- 每个 tool result 的 `details` 保存 `tasks` 与 `nextId` 快照。
- `session_start`、`session_tree` 和 `session_compact` 从当前 branch 最后的 Todo 快照恢复状态。
- 原始 tool call/result 仍保存在 session 中；这里只隐藏 TUI 成功节点。

## 开发

```bash
pnpm --filter @zhcsyncer/pi-todo check
pi --no-extensions -e ./packages/pi-todo --list-models __pi_todo_check__
```

## 许可证

MIT。参见 [`LICENSE`](./LICENSE) 和 [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE)。
