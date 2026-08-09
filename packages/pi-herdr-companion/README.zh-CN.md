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

在 caller identity 完整的 Herdr 环境内，会提示模型用 `herdr_process` 运行 dev/preview/watch，并解释 `/btw` 的 merge 语义。Herdr 外会明确 launch 功能不可用，并建议使用 tmux，而不是 `nohup`、`&` 或 `disown`。如果 `HERDR_ENV=1` 但缺 caller pane 或 socket identity，prompt 会输出 `degraded/unavailable`，且不会提示实际未注册的 process tool。

将 `runtime.injectSystemPrompt` 设为 `false`，可只关闭这段 prompt。

### 托管进程

`herdr_process` 是单个 Google-compatible action tool，包含四种 action：

- `start`：默认向下 split、保持 caller focus、运行命令，可选等待 literal 或 regex readiness，成功后才持久化 ownership
- `list`：用 Herdr live panes 对账持久化 registry
- `logs`：合并有界的 `recent-unwrapped` scrollback 与当前 `visible` viewport，先去除两者最大的精确行重叠，再按 Pi 的 2,000 行 / 50KB 限制保留尾部。这样可保留 Herdr 0.8 可能只通过 `visible` 暴露的短输出；非 missing-pane 的单侧读取失败会 fallback 到另一侧
- `stop`：只关闭 companion 创建且已登记的 pane

调用示例：

```json
{"action":"start","command":"pnpm dev","readyMatch":"Local:","lifetime":"session"}
{"action":"list"}
{"action":"logs","target":"dev","lines":300}
{"action":"stop","target":"dev"}
```

`start` 默认 direction 为 `down`、ratio 为 `0.35`、ready timeout 为 60 秒、cwd 等于 Pi cwd、不改变 focus，lifetime 为 `session`。`readyMatch` 与 `readyRegex` 互斥。Herdr `wait-output` 能看到 shell 的 command echo，因此若 literal `readyMatch` 出现在 `command` 中，会在 split 前直接拒绝。请使用不出现在启动命令中的 marker，或使用 `^READY$` 这类不会匹配整行 command echo 的 anchored `readyRegex`。

Ownership 写入 session，并在 reload/compaction 后重建。`/tree` 导航会先把当前 runtime ownership 与绑定精确 session/caller 的 branch-only 记录保守合并，把 union 写入新 branch，再对账 live pane/process 状态。因此瞬时 pane-list 失败不会丢失 current 或有效 branch ownership；缺失或不可靠的 process information 仍按非破坏方式处理。工具永不关闭 caller 或未登记 pane。生命周期如下：

| 事件 | `session` process | `persistent` process |
| --- | --- | --- |
| `/reload` | 保留并对账 | 保留并对账 |
| `/tree` | 保留 live runtime ownership，并重新绑定到所选 branch | 同左 |
| quit、`/new`、`/resume`、`/fork` | 正常 teardown 时关闭 | 保留 |
| 用户手动关闭 pane | 对账时移除 stale ownership | 对账时移除 stale ownership |
| command 已返回 shell | 保留 ownership 并标记 `exited`；正常 teardown 或显式 `stop` 时关闭 | 保留 ownership 并标记 `exited`，直到显式 `stop` |

对账会 typed 解析 `pane process-info --pane`，区分前台 command 与 pane 的 interactive shell。超过短暂启动 grace 后，可靠的 returned-shell 结果会显示为 `exited`，但 entry 仍保留在 registry。这样 crash/exit logs、显式 `stop`、重复 label 防护与 session-lifetime cleanup 都仍可用，不会制造无人管理的 pane。只有 live pane list 中已不存在的 pane 才会移除 stale ownership。缺失或不可靠的 process information（包括旧版 Herdr 行为）会标记为 `unknown`，绝不会据此删除。替换 session 的 cleanup 会先按持久化 ownership 尝试关闭，再执行可能瞬时失败的 `pane list` 探测。

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

Merge 只包含 child 的 user/assistant 文本，排除 thinking、tool payload 与 image，并在 48KiB transcript 预算内保留最新内容。Parent idle 后会发送一条 custom message：它把 transcript 与 child 编写的 follow-up 合在一起，携带 durable `requestId`/`launchId` details，参与 context、绕过 user input transform，并触发 parent turn。Pi 0.84 的 `sendMessage` wrapper 是 fire-and-forget，因此 dispatch 返回值绝不作为投递证据；只有后续扫描在 session 中观察到该精确 custom message，parent 才写 accepted ack。

Recovery 在**同一 parent session 只有一个 active Pi owner**的前提下提供 durable、按 request 去重的恢复。私有锁会串行化扫描，dispatch lease 会在 fire-and-forget 调用附近可能崩溃时延迟恢复。它不承诺两个同时打开同一 session 的 Pi 实例之间严格 exactly-once。若 crash 或异常延迟的 append 超过 lease，可能发生携带同一 request tag 的重试；session evidence 能去重正常 reload recovery，但 ExtensionAPI 0.84 无法消除 dispatch/append 的残余窗口。

Child 会把首个 side-thread Pi session ID 持久化到私有 launch state。同 ID 的 `/reload` 可继续；`/new`、`/resume` 或 `/fork` 到另一 session 后，会带清晰 warning 禁用 parent-context replay、merge、ack polling/cleanup 与 launch-draft 提交。新 session 可独立继续，但不会把无关 transcript merge 回旧 parent。

Native replay 只是 best-effort 的 prompt-cache 优化。它要求 model/thinking 继续 inherit、parent system prompt 已知且 fingerprint 匹配，并且所有 active tool 的 name、description、parameters、prompt guidelines 构成的有序 fingerprint 完全一致。首次缺可靠证据、任一 override 或 schema 不一致都会走 portable flattened snapshot，并记录 cache-break 原因。后续 `before_agent_start` handler 与 provider-level request rewrite 仍可能在 companion 检查后改变最终 payload，因此 native mode 不承诺最终 provider payload 等价，也不保证 cache hit。

Launch payload 与 mailbox 位于全局 Pi agent dir 下按 socket 隔离的私有 state root。目录权限为 `0700`，文件为 `0600`，写入使用 atomic rename，capability/context 不进入 CLI argv。Delivery lock 超时回收会先确认 owner PID 已死亡，并在 unlink 前立即重读 token、inode/device 与 mtime；有疑点时宁可 timeout，也不删除 replacement lock。Side agent name 会持久化并通过 `agent get` 解析，因此 pane move 不会让旧 pane ID 被误判 stale。Stale cleanup 会保守保留无法可靠解析 agent/pane、pane 仍 live/unknown 或 merge 尚未 ack 的 launch。

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
- Merge 绑定精确 parent session ID，child 也绑定首个 side-thread session ID。Parent 不可用时，请求保持 pending 且可诊断；child 切换 session 后会禁用 side-thread 行为。
- 收到 accepted ack 后，child 先用持久化 Herdr agent name 解析当前 pane，再聚焦精确 parent，最后才关闭自身。Parent focus 失败或 pane 无法可靠解析时会保留 side pane 并 warning。
- 正常失败路径会清私有 payload，并且只会尽力关闭 split 成功/失败响应明确返回的 pane ID。Split 失败无明确 ID 时会报告可能 orphan，并刻意不碰无法识别的 pane。进程/主机硬崩仍无法提供绝对 cleanup 保证。
- POSIX filesystem 没有 portable 的 unlink-if-inode-matches 原语。实现会在删除前立即复核 lock identity，但最后一次 check/unlink 之间仍有不可消除的竞态；观察到 replacement 或 ownership 不确定时采用保守 timeout。
- Herdr 0.7.5+ 是兼容下限；缺 `process-info` 时降级为不删除的 `unknown`，高级 layout 操作刻意不在范围内。

## 开发

```bash
pnpm --filter @zhcsyncer/pi-herdr-companion typecheck
pnpm --filter @zhcsyncer/pi-herdr-companion test
pnpm --filter @zhcsyncer/pi-herdr-companion check
npm pack --dry-run ./packages/pi-herdr-companion
```

## 许可证

MIT。`/btw` 产品行为和部分私有 context/mailbox 实现改编自 Oscar Gabriel 的 MIT 许可 [`pi-herdr-btw@0.3.0`](https://www.npmjs.com/package/pi-herdr-btw)。保留的声明与来源记录见 [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE) 和 [`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md)。
