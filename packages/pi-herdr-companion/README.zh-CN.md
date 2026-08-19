# @zhcsyncer/pi-herdr-companion

[English](./README.md)

供 Pi 在 [Herdr](https://herdr.dev) 中使用的独立扩展。提供可见的长跑进程 Pane、临时 `/btw` 支线、可配置的 blocked 上报、设置界面，以及用于当前 linked worktree 的 `/herdr-worktree cleanup`。

Pi 不在 Herdr 中，或 Herdr 无法识别当前 Pane 时，扩展保持静默。

## 来源

`/btw` 产品行为改编自 MIT 许可的 [`pi-herdr-btw`](https://www.npmjs.com/package/pi-herdr-btw) 0.3.0。托管进程、blocked 上报和 `/herdr-config` 是本包原作。

## 功能

- `herdr_process` 在可见的 Herdr Pane 里启动、列出、检查和停止托管的长跑命令。
- Pi TUI 在 editor 下方显示进程列表：`→` 激活，`↑` / `↓` 选择，`s` 确认后停止，`Esc` 回到 editor。
- `/btw` 打开临时支线。只有你主动 merge 后，内容才会回到父会话。
- 已配置的工具和扩展事件可以在 Herdr 里显示为 blocked。
- `/herdr-config` 编辑 runtime guidance、进程默认值和 blocked 规则。
- `/herdr-worktree cleanup` 拆掉当前 linked Herdr worktree。默认同时删除本地分支；`--keep-branch` 只拆 worktree。远程分支默认不动。

## 安装

需要 Node.js 22.19+、Pi 0.84+、Herdr 0.7.5+（对着 0.8.0 开发）。还要安装 Herdr 的 Pi integration：

```bash
herdr integration install pi
```

独立安装：

```bash
pi install npm:@zhcsyncer/pi-herdr-companion
```

从 checkout 安装：

```bash
pi install /absolute/path/to/pi-extensions/packages/pi-herdr-companion
```

`@zhcsyncer/pi-extensions` 为发版一致性内嵌了这些源码，但**不会**启用 Companion。请单独安装。

`herdr_process` 和 blocked 上报可用于 TUI、RPC、JSON 和 print mode。`/btw`、`/herdr-config` 与 `/herdr-worktree` 需要 Pi TUI。

## 进程

开发服务器、预览和 watcher 用 `herdr_process`：

```json
{"action":"start","label":"dev","command":"pnpm dev","readyMatch":"Local:","lifetime":"session"}
{"action":"list"}
{"action":"logs","target":"dev","lines":300}
{"action":"stop","target":"dev"}
```

`stop` 只关闭本扩展创建的 Pane。默认向下拆分 `0.35`，使用 Pi 当前工作目录，等待 readiness 60 秒，`lifetime` 为 `session`。`/btw` 使用同一个拆分方向。

POSIX 默认 `shell: "bash"`，避免 Fish 或其他 interactive pane shell 改写命令。只有命令必须用那个 shell 时才选 `shell: "pane"`。Windows 默认 `pane`。

`session` Pane 随这次 Pi session 结束而关闭（`quit`、`/new`、`/resume`、`/fork`）。`persistent` Pane 一直留到你停止。`/reload` 和 `/tree` 两种都会保留。命令如果已经回到 shell，日志会留到 teardown 或 `stop`。

Widget 不提供 Logs；模型要读输出时用 `herdr_process logs`，这样不会抢焦点。停止含有 agent session 的 Pane 也会关掉那个 session。

## `/btw`

父会话：

```text
/btw
/btw <question>
/btw ask <question>
/btw merge
/btw help
```

子会话：

```text
/btw merge <parent follow-up prompt>
/btw merge
/btw help
```

Child 是同一工作目录里另一扇可见的 Pi。它继承父会话的 model 和 thinking level，并使用 Pi 的正常默认工具。有 question 时会等 child 就绪再发送；单独 `/btw` 打开空白 child。

Child 是**临时的，不会存成 Pi session**。merge 前关掉，未合回的对话会丢失。Merge 把近期的 user/assistant 文本发到原来的父会话，不带 tool call、thinking 和 image。父会话关闭或忙碌时，重新打开同一个父会话再执行 `/btw merge`。

不要同时加载另一个注册 `/btw` 的扩展。在 child 里执行 `/new`、`/resume` 或 `/fork` 会断开 merge；`/reload` 不会。

## Blocked 上报

已配置的工具在执行期间，或已配置的扩展事件 payload 为 `{ active: true }` 时，Herdr 可以显示 blocked 标签。`{ active: false }` 清除事件。默认把 `ask_user_question` 显示为 `question`。

## `/herdr-worktree`

在已经做完的 feature session 里执行：

```text
/herdr-worktree cleanup
/herdr-worktree cleanup --keep-branch
```

默认：拆当前 linked worktree，并删除本地分支。`--keep-branch` 只拆 worktree。当前在 `main` / `master`、主 checkout、或工作区有未提交改动时会直接拒绝。动手前只确认一次。远程分支不会被删除。

## 设置

```text
/herdr-config
/herdr-config reset
```

`/herdr-config` 改的是草稿。**Save and close** 才写入；**Discard changes** 关闭且不保存；**Reset draft** 把草稿换成包装箱默认值，仍要保存才写盘。`/herdr-config reset` 会立刻把已保存文件恢复为默认。

```json
{
  "runtime": {
    "injectSystemPrompt": true
  },
  "process": {
    "defaultDirection": "down",
    "defaultRatio": 0.35,
    "readyTimeoutMs": 60000,
    "defaultLifetime": "session",
    "defaultShell": "bash"
  },
  "blocked": {
    "events": [],
    "tools": [
      { "name": "ask_user_question", "label": "question" }
    ]
  }
}
```

Windows 使用 `"defaultShell": "pane"`。关掉 `injectSystemPrompt` 只是不再追加 Herdr guidance，工具仍可用。Blocked rule editor 每行写一条 `exact_name = Herdr label`。

## 许可证

MIT。`/btw` 行为改编自 Oscar Gabriel 的 MIT 许可 [`pi-herdr-btw@0.3.0`](https://www.npmjs.com/package/pi-herdr-btw)。声明见 [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE) 和 [`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md)。
