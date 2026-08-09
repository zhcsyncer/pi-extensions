# @zhcsyncer/pi-herdr-companion

[English](./README.md)

一个独立的 Pi package，为 [Herdr](https://herdr.dev) 提供范围收敛、所有权安全的 companion 层：不可变 runtime 上下文、托管长运行进程 pane、完整 `/btw` 侧线，以及 blocked 状态适配器。

它**不依赖、也不内嵌** `@ogulcancelik/pi-herdr`。Herdr 本体及其 managed Pi integration 仍是外部前置条件。

## 环境要求

- Node.js 22.19+
- Pi 0.84+
- Herdr 0.7.5+（基于 Herdr 0.8.0 开发）
- process 与 `/btw` launch 功能要求 Pi 位于 Herdr managed pane 内
- Herdr managed `herdr-agent-state.ts` reporter 要求执行过 `herdr integration install pi`

单独安装本包：

```bash
pi install npm:@zhcsyncer/pi-herdr-companion
```

从 checkout 安装：

```bash
pi install /absolute/path/to/pi-extensions/packages/pi-herdr-companion
```

聚合包 `@zhcsyncer/pi-extensions` 为保持发版一致性会内嵌源码，但刻意**不会**自动启用这个 extension。需要 companion 时请安装 standalone 包。

## 能力

### Runtime 上下文

extension 加载时只读取一次 `HERDR_ENV`、caller pane/tab/workspace ID 与 socket path。之后每个 `before_agent_start` turn 都收到相同的短块，不再反复探测环境或当前聚焦 pane。

Herdr 内会提示模型用 `herdr_process` 运行 dev/preview/watch，并解释 `/btw` 的 merge 语义。Herdr 外会明确 launch 功能不可用，并建议使用 tmux，而不是 `nohup`、`&` 或 `disown`。

将 `runtime.injectSystemPrompt` 设为 `false`，可只关闭这段 prompt。

### 托管进程

`herdr_process` 是单个 Google-compatible action tool，包含四种 action：

- `start`：默认向下 split、保持 caller focus、运行命令，可选等待 literal 或 regex readiness，成功后才持久化 ownership
- `list`：用 Herdr live panes 对账持久化 registry
- `logs`：读取 owned pane 的 recent-unwrapped 输出；按 Pi 的 2,000 行 / 50KB 限制保留尾部
- `stop`：只关闭 companion 创建且已登记的 pane

调用示例：

```json
{"action":"start","command":"pnpm dev","readyMatch":"Local:","lifetime":"session"}
{"action":"list"}
{"action":"logs","target":"dev","lines":300}
{"action":"stop","target":"dev"}
```

`start` 默认 direction 为 `down`、ratio 为 `0.35`、ready timeout 为 60 秒、cwd 等于 Pi cwd、不改变 focus，lifetime 为 `session`。`readyMatch` 与 `readyRegex` 互斥。

Ownership 写入 session，并在 reload/compaction 后重建。工具永不关闭 caller 或未登记 pane。生命周期如下：

| 事件 | `session` process | `persistent` process |
| --- | --- | --- |
| `/reload` | 保留并对账 | 保留并对账 |
| quit、`/new`、`/resume`、`/fork` | 正常 teardown 时关闭 | 保留 |
| 用户手动关闭 pane / process 消失 | 对账时移除 stale ownership | 对账时移除 stale ownership |

主机或 Pi 硬崩无法保证 pane cleanup。可恢复 owning session 后调用 `herdr_process list`/`stop`，或在 Herdr 中关闭已知 pane。

### `/btw` 侧线

父端命令：

```text
/btw
/btw <question>
/btw ask <question>
/btw config ...
/btw merge
/btw help
```

子端命令：

```text
/btw merge <parent follow-up prompt>
/btw merge
/btw help
```

Launch 使用 Pi 的 compaction-aware session builder 快照 parent active branch，默认继承 cwd、model、thinking level 与 active tools。除非开启 `auto-submit`，问题会先进入 child editor。Child 是独立且可见的 Pi 进程；显式 merge 前，它的 transcript 不进入 parent。

Merge 只包含 child 的 user/assistant 文本，排除 thinking、tool payload 与 image，并在 48KiB transcript 预算内保留最新内容。Parent 等待 idle 后，追加一条可见且参与 context 的 merge message，提交 child 编写的 follow-up，并持久推进 `message_appended`、`prompt_submitted`、`acked` 三阶段。私有文件锁、request capability、精确 parent-session 绑定、dispatch lease 与 session 证据共同防止并发扫描和 reload recovery 重复投递。Child 只有在收到 accepted ack 后才回焦 parent 并关闭自身。

当 model、thinking、tools 与 effective system prompt 都和 parent 完全一致时，child replay 原生 parent prefix，以争取 provider prompt cache。任一 override 或 exact system prompt 不可用都会改走 portable flattened snapshot，并在 child prompt 中记录 cache break 原因。

Launch payload 与 mailbox 位于全局 Pi agent dir 下按 socket 隔离的私有 state root。目录权限为 `0700`，文件为 `0600`，写入使用 atomic rename，capability/context 不进入 CLI argv。Stale cleanup 会保守保留 pane 仍 live/unknown 或 merge 尚未 ack 的 launch。

### Blocked 适配器

本包监听：

```text
rpiv:ask-user:blocked { active }
```

并安全发出配平的：

```text
herdr:blocked { active, label: "question" }
```

Adapter 跟踪 nested wait，并在 `agent_settled` 与 `session_shutdown` 强制清理。Listener 失败不会反向破坏 Ask User Question。它只在 Herdr TUI session 启用。Plan Mode 已直接发 `herdr:blocked`，因此刻意不代理 Plan Mode。

## 配置

只读取全局 agent-dir 文件：

```text
$PI_CODING_AGENT_DIR/herdr-companion.json
# 默认：~/.pi/agent/herdr-companion.json
```

永不接受项目配置。配置缺失时使用默认值，且不会创建文件。只有用户显式执行 `/btw config ...` 后，才会创建或更新全局文件。

```json
{
  "runtime": {
    "injectSystemPrompt": true
  },
  "process": {
    "defaultDirection": "down",
    "defaultRatio": 0.35,
    "readyTimeoutMs": 60000,
    "defaultLifetime": "session"
  },
  "btw": {
    "autoSubmit": false,
    "model": "inherit",
    "thinking": "inherit",
    "tools": "inherit",
    "split": "down"
  },
  "blocked": {
    "askUserQuestion": true
  }
}
```

BTW 快捷配置：

```text
/btw config
/btw config auto-submit on|off
/btw config model inherit|provider/model
/btw config thinking inherit|off|minimal|low|medium|high|xhigh|max
/btw config tools inherit|all|read-only|none
/btw config split down|right
/btw config reset
```

`tools: inherit` 有最佳 cache 行为与完整 parent 能力，但不是 sandbox。若 side thread 不应修改共享文件，请使用 `read-only` 或 `none`。

## 共存与迁移

- 保留 Herdr managed `herdr-agent-state.ts`；本包只向其保留事件总线发送事件，不 patch 它。
- 移除单独安装的 `pi-herdr-btw`，避免出现重复 `/btw` command。
- 验证 companion adapter 后移除旧 `herdr-blocked-bridge.ts`，否则 blocked count 会重复。
- `pi-recap` 可继续重命名 caller pane。Companion 只重命名自己的 process pane，`/btw` agent pane 由 Herdr 命名。
- `@ogulcancelik/pi-herdr` 是可选项，不是依赖。只有需要更广泛的 layout/agent 控制面时才安装；companion 不提供通用 layout、fleet、worktree、ping 或 picker。

## 安全与限制

- 每次 Herdr 调用都使用 argv、有限 timeout，并对 CLI 承诺为 JSON 的响应做防御式解析。
- Process 与 BTW ownership registry 是不同 state machine，不能互相关闭 pane。
- `/btw` 与 parent 共享 cwd。并发文件/Git 修改、dev server 与端口可能冲突。
- Parent snapshot 是静态的；后续 parent 活动不会自动同步到 child。
- Merge 绑定精确 parent session ID。该 session 不可用时，请求保持 pending 且可诊断。
- 正常失败路径会清私有 payload，并尽力关闭已经识别的 orphan pane。进程/主机硬崩，或 split 结果含糊且无法恢复 pane ID 时，无法提供绝对 cleanup 保证。
- Herdr 0.7.5+ 是兼容下限；高级 layout 操作刻意不在范围内。

## 开发

```bash
pnpm --filter @zhcsyncer/pi-herdr-companion typecheck
pnpm --filter @zhcsyncer/pi-herdr-companion test
pnpm --filter @zhcsyncer/pi-herdr-companion check
npm pack --dry-run ./packages/pi-herdr-companion
```

## 许可证

MIT。`/btw` 产品行为和部分私有 context/mailbox 实现改编自 Oscar Gabriel 的 MIT 许可 [`pi-herdr-btw@0.3.0`](https://www.npmjs.com/package/pi-herdr-btw)。保留的声明与来源记录见 [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE) 和 [`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md)。
