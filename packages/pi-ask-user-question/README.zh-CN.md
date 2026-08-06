# pi-ask-user-question

[English](./README.md)

面向 Pi 的结构化问答扩展，维护自 `@juicesharp/rpiv-ask-user-question`。它注册 `ask_user_question` 工具，让模型在需求不明确时一次提出 1–4 个带说明的单选或多选问题。

该 fork 将问卷放入 Pi 的正常自定义组件布局，而不是覆盖底部区域的全屏 overlay；同时支持上下文感知的数字键直选，并在交互结束后提供可审计结果渲染。

## 安装

只安装问答扩展：

```bash
pi install npm:@zhcsyncer/pi-ask-user-question
```

也可以安装完整扩展集合：

```bash
pi install npm:@zhcsyncer/pi-extensions
```

## 交互

- `1`–`5`：焦点不在 `Type something.` 时，`1`–`N` 直接选择或切换正式选项，`N+1` 聚焦 `Type something.`。
- `↑` / `↓`：移动焦点。
- `Enter`：确认当前单选项；多选中切换当前项，聚焦 `Next` 时提交该题。
- `Space`：切换当前多选项。
- `Tab` / `Shift+Tab`：在多题问卷的题目与提交页之间切换。
- `n`：为当前题添加备注。
- `Esc`：取消整个问卷。
- `Ctrl+]`：把问卷缩成一行或恢复；可通过配置修改或关闭。

每道题会自动追加 `Type something.`，用于输入选项之外的回答。未进入输入状态时，可按紧随正式选项的编号直接聚焦该行；聚焦后所有数字都作为普通文本输入。多选题的 `Next` 仍只能通过导航与 `Enter` 触发，避免数字误提交。

## TUI 布局与工具展示

问卷通过非 overlay 的 `ctx.ui.custom()` 渲染：交互期间临时替换底部 editor、保留并在结束后恢复 editor 草稿，同时参与 Pi 正常布局计算，使 transcript 重排且 footer 始终单独可见。

交互进行时不额外显示 pending tool call；结束后结果节点展示每道题的答案、回答类型和备注，展开后可阅读受长度限制的已选 preview。取消时仍保留可审计的部分回答，校验与运行错误始终可见。宽屏左右分栏时，内容宽度的 preview 框会在右侧剩余列中居中。

## 配置

配置文件沿用上游位置：`$XDG_CONFIG_HOME/rpiv-ask-user-question/config.json`，未设置 `XDG_CONFIG_HOME` 时使用 `~/.config/rpiv-ask-user-question/config.json`。

```json
{
  "collapseKey": "alt+o",
  "guidance": {
    "promptSnippet": "Ask before guessing when requirements are ambiguous"
  }
}
```

`collapseKey` 设为 `"off"` 可关闭折叠快捷键。`guidance.promptSnippet` 和 `guidance.promptGuidelines` 可覆盖默认模型指导。

## 来源

- 上游：[`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question)
- 基线：`@juicesharp/rpiv-ask-user-question@2.4.0` / `a1531ed4207c21a00941c62571bc1bd3e386cfcb`
- 保留的上游文档：[`UPSTREAM_README.md`](./UPSTREAM_README.md)
- 保留的上游版本历史：[`UPSTREAM_CHANGELOG.md`](./UPSTREAM_CHANGELOG.md)

## 开发

```bash
pnpm --filter @zhcsyncer/pi-ask-user-question check
pi --no-extensions -e ./packages/pi-ask-user-question --list-models __pi_ask_user_question_check__
```

## 许可证

MIT。参见 [`LICENSE`](./LICENSE) 和 [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE)。
