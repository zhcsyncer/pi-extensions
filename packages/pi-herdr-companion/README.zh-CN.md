# @zhcsyncer/pi-herdr-companion

[English](./README.md)

一个供 Pi 在 [Herdr](https://herdr.dev) 中使用的独立扩展，提供可见的长跑进程 Pane、最小异步 Pi Worker 派发、临时 `/btw` 支线、可配置的 blocked 状态上报和统一设置界面。

## 提供的能力

| 能力 | 用户获得什么 |
| --- | --- |
| Herdr 上下文 | Pi 获得稳定的 Herdr caller 身份，不必反复探测焦点或环境。 |
| 托管进程 | 启动、检查、聚焦和停止 owned 长跑命令，并提供可导航的 TUI Process Widget。 |
| Pi Worker | 在已有 Herdr Pane 启动一个 Pi Worker，并异步接收其显式最终报告。 |
| `/btw` 支线 | 在临时 Pi 对话中探索问题，并且只在你明确要求时合回父会话。 |
| Blocked 上报 | 让 Herdr 将已配置的工具或扩展事件显示为 blocked。 |
| 统一设置 | 通过 `/herdr-config` 配置 runtime guidance、进程默认值和 blocked 上报。 |

## 前置条件与安装

- Node.js 22.19+
- Pi 0.84+
- 核心进程管理需要 Herdr 0.7.5+（开发基于 Herdr 0.8.0）
- 跨 Tab/Workspace 精确聚焦 Process Widget 需要 `herdr pane focus <pane_id>` 已出现在帮助中的 Herdr build
- POSIX 默认进程 shell 需要 Bash；Windows 使用 Pane 自身的 shell
- 安装 Herdr 的 Pi integration：

```bash
herdr integration install pi
```

安装独立包：

```bash
pi install npm:@zhcsyncer/pi-herdr-companion
```

从 checkout 安装：

```bash
pi install /absolute/path/to/pi-extensions/packages/pi-herdr-companion
```

聚合包 `@zhcsyncer/pi-extensions` 为保持发版一致性包含了这些源码，但**不会**启用 Companion。请单独安装，或在 Pi 中显式添加它。

当 Pi 不在 Herdr 中，或 Herdr 无法识别 caller Pane 时，扩展保持完全静默。`herdr_process`、`herdr_worker` 与 blocked 上报可用于 TUI、RPC、JSON 和 print mode；`/btw` 与 `/herdr-config` 只在 Pi TUI mode 中可用。

## 最小 Pi Worker

当一个已有 Herdr Pane 已停在可用 shell prompt，且需要它异步执行一个 Pi 任务时，使用 `herdr_worker`：

```json
{"paneId":"w1:p4","name":"reviewer","prompt":"检查当前 diff，只报告可执行的问题。"}
```

Worker name 必须在 live Herdr agent 中唯一，并匹配 `[a-z][a-z0-9_-]{0,31}`。仅在首次实际派发时，caller 才会复用已有 Herdr agent name，或根据当前 Pi session ID 懒生成并设置一个稳定 name。只加载 Companion 不会把普通 Pi session 自动改名。

工具会在指定 Pane 启动带短 callback contract 的 `pi`，再把任务正文作为普通 user prompt 提交；它不使用 `--wait`，提交后即返回。Worker 必须发送一次且仅一次以 `[pi-herdr-worker-report:v1]` 开头的最终成功或确认失败报告。Parent 会把这条由 Herdr 到达的普通输入改为触发式 Pi `followUp`，因此 parent 忙碌时到达的报告不会 steer 当前 turn。Herdr `idle` 与 `done` 刻意不作为完成信号。

这是在线 best-effort handoff，不是持久任务系统。Parent 与 Worker 必须在同一 Herdr server 中保持在线，直到报告完成交换。它不提供持久化、任务账本、轮询、状态跟踪、重启恢复、重试、批次、Pane/Worktree 创建或自动 cleanup。若 Pi 已启动但任务 prompt 尚未被接受就失败，可能留下需要手工检查或清理的空闲 Worker。

## 托管进程

开发服务器、预览、watcher 等需要持续可见的长跑命令应使用 `herdr_process`：

- `start` 创建 owned Pane，并可等待 readiness。
- `list` 显示 owned Pane 及其当前状态。
- `logs` 读取受限的近期输出。
- `stop` 只关闭 Companion 创建并登记的 Pane。

示例：

```json
{"action":"start","label":"dev","command":"pnpm dev","readyMatch":"Local:","lifetime":"session"}
{"action":"list"}
{"action":"logs","target":"dev","lines":300}
{"action":"stop","target":"dev"}
```

默认向下拆分 `0.35`，使用 Pi 当前工作目录，不改变焦点，readiness timeout 为 60 秒，lifetime 为 `session`。`/btw` 使用同一个默认拆分方向。

### TUI Process Widget

只要存在托管进程，Pi TUI 就会在 editor 下方显示实时进程列表。Editor 为空时：

- 按 `→` 激活列表；
- 用 `↑` / `↓` 选择进程；
- 按 `Enter` 或 `f` 聚焦其当前准确的 Herdr Pane；
- 按 `s` 并二次确认，通过与 `herdr_process stop` 相同的 ownership 检查停止进程；
- 按 `Esc` 返回 editor。

Widget 会标记包含 agent session 的 Pane，并在 Stop 前明确提示该 session 也会关闭。Widget 不重复提供 Logs：模型需要在不切换焦点时检查输出，仍使用 `herdr_process logs`。Transcript 中的 Tool row 默认保持紧凑；展开 Pi Tool 输出后可查看 command、当前位置、进程行或受限的完整日志正文。

POSIX 默认使用 `shell: "bash"`，因此 Bash 语法不会被 Fish 或其他 Pane interactive shell 重新解释。只有命令明确使用该 shell 的语法时才选择 `shell: "pane"`。Windows 默认使用 `pane`，不提供 Bash transport。

`readyMatch` 与 `readyRegex` 不能同时使用。Readiness marker 不应被启动命令本身的回显满足；必要时请使用更具体的 marker 或 anchored regex。

### 进程生命周期

| 事件 | `session` | `persistent` |
| --- | --- | --- |
| `/reload` 或 `/tree` | 保留并刷新当前 Pane 地址 | 保留并刷新当前 Pane 地址 |
| quit、`/new`、`/resume` 或 `/fork` | 正常 teardown 时关闭 | 保留在 owning session 中 |
| 命令退出并返回 shell | 保留日志，直到 teardown 或 `stop` | 保留日志，直到 `stop` |
| 手工关闭 Pane | 下次刷新状态时从托管进程列表移除 | 同左 |

仍在等待 readiness 的 start 会在 Pi session reload 或切换时取消并关闭。Owned Pane 移动到其他 Tab 或 Workspace 后，public Pane ID 会变化，但只要仍是同一 Herdr server 内的同一 live terminal，Companion 就会继续关联它。

生命周期清理在关闭 Pane 前，会刷新 Herdr live Pane 列表并核对保存的 terminal identity。若无法完成核验，Companion 会保留这个在 Herdr 中可见的 Pane/进程供手工清理，而不是冒险关闭 caller Pane 或不属于它的 Pane。请使用 `herdr_process list` 和 `stop`，或直接在 Herdr 中关闭已经确认的 Pane。

## 临时 `/btw` 支线

父会话命令：

```text
/btw
/btw <question>
/btw ask <question>
/btw merge
/btw help
```

子会话命令：

```text
/btw merge <parent follow-up prompt>
/btw merge
/btw help
```

Launch 会取得当前父分支的静态快照、共享 cwd，并继承 parent 的 model 与 thinking level。Child 使用 Pi 的正常默认工具。提供 question 时会立即提交；单独执行 `/btw` 则打开空白 child。Child 是独立且可见的 Pi 进程；只有显式 merge 后，它的对话才会进入父会话。

Child 是**临时的，不会保存为 Pi session**。在 merge 前关闭它，会永久丢失尚未合回的 child 对话。用于投递和清理的私有协调文件可能短暂保留，但它们不是可恢复的 transcript。

Merge 会把 child 的 user/assistant 文本发送到准确的父会话。Tool call、thinking 和 image 不会合入，并且只保留 48 KiB 限制内最新的文本。如果 parent 已关闭或正忙，请求会等待；重新打开准确的父会话后，可使用 `/btw merge` 扫描 pending request。

Parent 确认投递后，child 通常会聚焦 parent 并自行关闭。如果 Herdr 无法确认 focus 或 cleanup，child 会保持打开并提示需要手工关闭的内容。

Pi session ID 不变时，child 可以正常 `/reload`。在 child 中执行 `/new`、`/resume` 或 `/fork` 会改变其身份并断开与 parent 的关联；此后 merge 不再可用，只能把 child 作为独立 Pi session 继续使用。

## Blocked 状态上报

Companion 可以把两类已配置 source 上报为 Herdr blocked：

- Pi tool 执行期间；
- 扩展事件 payload 为 `{ active: true }` 时，并由 `{ active: false }` 清除。

每条规则使用准确 source name 和显示 label。默认把 `ask_user_question` 上报为 `question`；扩展事件规则默认为空。

## 配置

在 Pi TUI mode 中打开设置界面：

```text
/herdr-config
```

`/herdr-config reset` 会重置全部 Companion 设置。

配置只保存在：

```text
$PI_CODING_AGENT_DIR/extension-data/pi-herdr-companion/config.json
# 默认：~/.pi/agent/extension-data/pi-herdr-companion/config.json
```

只有保存设置后才会创建文件。

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

以上示例使用 POSIX shell 默认值；Windows 使用 `"defaultShell": "pane"`。`runtime.injectSystemPrompt` 控制是否在每次模型调用的 system prompt 中追加 Herdr guidance；关闭它不会禁用工具本身。

Blocked rule editor 每行填写一条 `exact_name = Herdr label`：

```text
review:blocked = review
approval_tool = approval
```

## 运行限制

- 保持 Herdr 托管的 Pi integration；Companion 不会替代它。
- 不要同时加载另一个注册 `/btw` 的扩展，否则 Pi 会显示带后缀的重复命令。
- Parent snapshot 是静态的，且 parent 与 child 共享 cwd；并发文件修改、Git 操作、server 和 port 可能冲突。
- Process 或 host hard crash 无法保证 Pane cleanup。请恢复 owning session 后使用 `herdr_process list`/`stop`，或在 Herdr 中关闭已知 Pane。
- Terminal identity 只在同一 Herdr server/socket 内有效，冷重启后不会沿用；Companion 会移除 stale ownership，而不会把它应用到另一个 terminal。
- 托管进程 ownership 只覆盖 `herdr_process` 创建的 Pane。`herdr_worker` 只在 caller 提供的 Pane 中启动 Pi，不接管 Pane ownership 或 cleanup；通用 layout、worktree 与 agent 控制仍由 Herdr CLI 提供。

## 开发

```bash
pnpm --filter @zhcsyncer/pi-herdr-companion typecheck
pnpm --filter @zhcsyncer/pi-herdr-companion test
pnpm --filter @zhcsyncer/pi-herdr-companion check
npm pack --dry-run ./packages/pi-herdr-companion
```

## 许可证

MIT。`/btw` 产品行为和部分私有协调机制改编自 Oscar Gabriel 的 MIT 许可 [`pi-herdr-btw@0.3.0`](https://www.npmjs.com/package/pi-herdr-btw)。保留声明与来源记录见 [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE) 和 [`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md)。
