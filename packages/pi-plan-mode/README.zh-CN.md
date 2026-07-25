# @zhcsyncer/pi-plan-mode

[English](./README.md)

严格、仅 TUI 启用的 Pi 临时规划权限模式。它组合 fail-closed 只读工具、[revdiff](https://github.com/umputun/revdiff) 终端评审、不可变 Plan revision、显式批准和紧凑的 Plan Mode Widget。

Plan Mode 是临时模式：批准后立即恢复进入规划前的工具，并在新的 Agent turn 中开始普通实现。扩展不维护执行或完成工作流。

## 环境要求

- Node.js 22.19 或更高版本
- Pi 0.81 或更高版本
- `revdiff` 位于 `PATH`，或用 `REVDIFF_BIN` 指向具有执行权限的文件
- Pi TUI 模式

每次 TUI Session 启动时，扩展都会预检 revdiff。若文件缺失或不可执行，Pi 会显示安装提示，并在该 Session 内保持 Plan Mode 禁用。安装完成后需重启 Pi。

macOS Homebrew 安装示例：

```bash
brew install umputun/apps/revdiff
```

## 行为

- `/plan on` 进入只读规划；`/plan off` 立即恢复之前的普通工具。用 `--plan` 启动 Pi 等价于首次执行 `/plan on`。
- `Ctrl+Alt+P` 切换同一模式。`/plan` 不带参数时只显示状态和用法，不做隐式切换。
- 规划阶段使用 fail-closed 白名单：`read`、`grep`、`find`、`ls`、获准的文档/搜索/提问工具和 `submit_plan`。
- Plan Mode 开启时会拦截 `bash`、`edit`、`write` 和未知自定义工具。
- 原始 Pi system prompt（包括 `AGENTS.md` 规则）会被保留并追加约束，而不是被替换。
- revdiff 无批注退出不等于批准。Pi 会要求明确选择 `Approve Plan`、`Keep planning` 或 `Cancel review`。
- 每次完整提交都会创建不可变的 `rN` Markdown 文件和 SHA-256 hash；获批 revision 永不覆盖。
- 批准后恢复普通工具、移除只读模式条、保留 Plan 摘要，并通过 displayed custom context message 开始实现，而不是创建 user-role turn。Transcript 只渲染紧凑批准事件，完整获批 revision 仍保留在模型上下文中。
- Steps 只是 `## Execution steps` 或 `## 执行步骤` 的展示投影，没有完成状态，也不会集成或探测 Todo 扩展。
- Plan 标题、正文、列表和必需章节标题可通过只读用户配置选择英文、简体中文或自动跟随会话语言。
- 通过 `ctx.mode === "tui"` 强制仅 TUI 启用。RPC、JSON、print 模式不会注册 Plan 工具、切换活动工具、注入提示或写入 Plan 状态。

这是能力边界，不是 OS sandbox。只读工具仍可访问 Pi 进程有权读取的文件。

## 工作流程

1. 运行 `/plan on`、按 `Ctrl+Alt+P`，或用 `--plan` 启动 Pi。
2. Agent 使用只读工具探索。
3. Agent 调用 `submit_plan`，提交标题和完整 Markdown Plan。
4. Pi 暂停自己的 TUI，把终端交给 revdiff。
5. 批注整批返回 Agent；完整重提会创建 `rN+1`，并用 revdiff 词内高亮打开 revision Diff。
6. 无批注 Review 返回 Pi，要求用户显式决定是否批准。
7. 批准会记录精确 revision 和 hash、关闭 Plan Mode、恢复普通工具，并在新的 turn 中开始普通实现。

实现中断沿用普通 Pi 语义。获批 Plan 会继续保留，但扩展不跟踪执行进度、不自动重启工作，也不要求完成工具。重新进入 Plan Mode 时，扩展会把关联 revision 注入规划上下文；Agent 仍须先检查当前工作区再修订。

## 命令与快捷键

| 交互 | 行为 |
|---|---|
| `/plan on` | 开启严格只读 Plan Mode |
| `/plan off` | 关闭 Plan Mode 并恢复普通工具 |
| `/plan` | 显示当前模式、内容语言/配置路径、Plan revision、路径和用法 |
| `--plan` | 让初始 TUI Session 直接开启 Plan Mode |
| `Ctrl+Alt+P` | 切换 Plan Mode |
| `Ctrl+Alt+O` | 展开或收起当前 Plan Steps |

`on` 和 `off` 支持命令参数补全。

## Plan 内容语言

Plan Mode 从 `<agent-dir>/plan-mode.json`（通常是 `~/.pi/agent/plan-mode.json`）读取一个可选用户级配置：

```json
{
  "contentLanguage": "zh-CN"
}
```

支持值：

- `auto`（默认）：遵循更高优先级或用户明确指定的语言；否则匹配当前用户语言。简体中文 Plan 使用中文章节标题，其他 Plan 使用英文标题。
- `en`：要求英文标题、内容和章节标题。
- `zh-CN`：要求简体中文标题、内容和章节标题。

扩展只读取该文件，不会自动创建或改写。编辑后需 reload 或重启 Pi。JSON 无效或值不受支持时会提示 warning 并回退到 `auto`。该设置只控制生成的 Plan 内容和标题；Plan Mode UI、revdiff UI、控制 prompt 和批准事件仍使用英文。

## Widgets

Plan Mode 开启时，编辑器下方显示使用标准 Unicode 暂停符号的 Widget：

```text
⏸ PLAN MODE · READ-ONLY                    /plan off · Ctrl+Alt+P
```

扩展直接使用 Unicode `⏸`，不增加字体设置、环境变量、Nerd Font 分支或 ASCII fallback。

存在 Plan 后，编辑器上方的摘要会独立于 Plan Mode 开关持续显示：

```text
▌ PLAN  OAuth migration                              APPROVED · r2
6 steps                                             Ctrl+Alt+O expand
```

收起时刻意隐藏 Plan 路径。展开后显示路径和只用于展示的 Steps：

```text
▌ PLAN  OAuth migration                              APPROVED · r2
~/.pi/agent/plans/…/revisions/r2.md
  1. 更新策略
  2. 运行集成测试
                                              Ctrl+Alt+O collapse
```

Steps 默认收起。`Ctrl+Alt+O` 展开终端高度的最多 30%，并限制在 3–10 个 step；溢出显示 `… +N more`。展开状态只属于当前 TUI，切换当前 Plan、revision、Session 或 tree branch 时重置。

批准后 transcript 增加一条紧凑 custom event：

```text
✓ PLAN APPROVED · OAuth migration · r2 · 6 steps
```

持久 Widget 不获取焦点，Pi 公开 Widget API 也没有鼠标点击回调，因此不支持直接点击。

## 存储方式

持久 Session 把应用数据与 Pi JSONL transcript 分开保存。可选语言配置与 `plans/` 目录同级：

```text
~/.pi/agent/plan-mode.json
~/.pi/agent/plans/
└── <plan-id>/
    ├── manifest.json
    ├── revisions/
    │   ├── r1.md
    │   └── r2.md
    └── .review/
        └── annotations.md
```

根目录通过 Pi 的 `getAgentDir()` 获取，因此会遵循 `PI_CODING_AGENT_DIR`。在平台支持时，目录权限为 `0700`，revision 和 manifest 文件权限为 `0600`。

每次提交都用 exclusive create 写入新 revision。manifest 记录稳定 Plan ID、当前与获批 revision、文档状态（`draft`、`changes_requested` 或 `approved`）、SHA-256 hash、提取出的展示 Steps、Session ID、cwd、时间戳和 revision lineage。

使用 `--no-session` 时，扩展改用 `$TMPDIR/pi-plan-<random>/`，不会向 Session 追加状态，并在 Session shutdown 时删除目录。异常崩溃的残留文件可能要等操作系统清理临时目录。

## Plan 产物

`submit_plan` 接收完整产物，而不是文件路径：

```text
submit_plan({
  title: "Add cache invalidation",
  markdown: "# Goal\n..."
})
```

修订同一个 Plan 时，传入上次提交返回的当前 Plan ID：

```text
submit_plan({
  planId: "20260723T140506-add-cache-a1b2c3d4",
  title: "Add cache invalidation",
  markdown: "# Goal\n... 完整修订 Plan ..."
})
```

省略 `planId` 会创建另一个 Plan。传入的 ID 必须匹配当前 Session branch 的 Plan；任意 ID 或跨 Session 接管会被拒绝。

Plan 上限为 256 KiB，并应覆盖九个必需章节。英文 Plan 使用 Goal、Non-goals、Current evidence、Decisions and rationale、Proposed changes、Execution steps、Verification、Risks 和 Assumptions；简体中文 Plan 使用目标、非目标、当前证据、决策与理由、拟议改动、执行步骤、验证、风险和假设。

## 安装

仅安装此扩展：

```bash
pi install npm:@zhcsyncer/pi-plan-mode
```

从本仓库试用：

```bash
pi --no-extensions -e ./packages/pi-plan-mode
```

## 失败处理

- 启动时找不到 revdiff 或文件不可执行：提示安装，并在当前 Session 禁用 Plan Mode。
- 启动后 revdiff 被删除、版本过旧而不支持 `--word-diff` 或运行失败：保留 planning 模式并报告错误。
- `plan-mode.json` 无效：提示 warning、使用 `contentLanguage: "auto"`，并继续允许 Plan Mode。
- Review 被中断：保留 planning 模式，不产生批准。
- revdiff 打开期间 Plan 内容或当前 revision 改变：拒绝批准并要求重新 Review。
- 恢复时元数据缺失或属于另一 Session：保持 normal，不接管该 Plan 指针。
- `/plan off`：恢复普通工具，但不删除或取消当前草稿。

## 开发

```bash
pnpm --filter @zhcsyncer/pi-plan-mode check
pi --no-extensions -e ./packages/pi-plan-mode --list-models nope
```

## 许可证

MIT
