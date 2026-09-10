# @zhcsyncer/pi-subagents

[English](./README.md)

[`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) 的维护向 fork，基线为 `v0.14.3`。可单独安装，也嵌入在 `@zhcsyncer/pi-extensions` 中。

[上游快照](./UPSTREAM_README.md) · [来源与上游差异](./UPSTREAM_SOURCE.md) · [上游许可证](./UPSTREAM_LICENSE)

## 安装

二选一：

```bash
pi install npm:@zhcsyncer/pi-subagents
# 或安装聚合包：
pi install npm:@zhcsyncer/pi-extensions
```

加载本 fork 前，请先从 Pi 设置中移除已有的 `@tintinweb/pi-subagents`：两者会注册相同的工具和 FleetView。

## 核心功能与上游差异

- **委派工作：** `Agent`、`get_subagent_result`、`steer_subagent`；支持自定义角色、模型/thinking 选择、继承上下文、调度和并发限制。
- **可直接使用的后台报告：** 完成通知携带最终报告，而不只是短预览。手动 Agent-tool 后台结果进入主 agent 的下一次推理；schedule/RPC 完成通知等待当前循环结束。
- **沿同一 agent 继续：** 对已完成或软轮次上限收尾的 agent 发送 steering，会自动在后台续跑。显式 `Agent(resume=...)` 支持前台或后台续跑，也可恢复符合条件的保存历史。
- **易读的进展：** 三个工具统一使用紧凑的 Claude Code 风格展示，明确区分排队/工作状态，显示友好时长、实际 model/effort、独立的累计用量与当前上下文，以及可展开的 Markdown 结果。
- **查看结束任务：** 普通 session 默认持久化；同目录运行在 Pi `/resume` 中挂到父会话下，也可从 `/agents` 的结束历史打开。
- **Worktree 显式启用：** 选择性移植上游 0.17 的 session/isolation 行为，但本 fork 的 `worktreeIsolation` 默认 `false`，与上游默认开启不同。
- **跨扩展集成：** protocol-v3 进程内 spawn 支持 inline 角色、调用方收口、路由关联和并发上限查询；可单独导入运行时而不自动注册 UI/工具。
- **保留可信观察者：** `pinnedExtensions` 即使在 isolated agent 中也加载观察者，但不会因此授予其工具。

自定义 agent、调度等基线功能参见[上游快照](./UPSTREAM_README.md)。投递、续跑、持久化、配置位置和 worktree 默认值请以本 fork 文档为准。

## 委派与接收结果

结果若是下一次 read、edit 或 decision 的前置条件，使用 **foreground**（默认）。只有确实存在互不重叠的并行工作时，才用 `run_in_background: true`。运行期间不要轮询、sleep 或重复子 agent 的证据收集。主 agent 仍负责综合与最终验证；应定向抽查高风险结论，而不是重跑整轮调查。

后台通知在**每条发出消息总计 16 KiB UTF-8** 的预算内携带完整最终报告；元数据和转义开销也计算在内。成组报告共享总预算，不是每个 agent 各有一份预算。超长报告会明确标注截断，并提示通过 `get_subagent_result(agent_id)` 获取完整结果。加上 `verbose: true` 可读取包含工具输出的对话。

`get_subagent_result` 的 `wait: true` 会等待完成。取消等待**只取消等待方**，不会终止子 agent，也不会取消其后续完成通知。要停止子 agent，请使用 FleetView 的停止操作。

手动 Agent-tool 后台完成（含自定义角色默认后台）使用 `steer`：主 agent 忙碌时，在当前已发出的工具结束后、下一次模型调用前进入上下文；空闲时，`triggerTurn: true` 启动推理。它无法撤回同一轮已发出的 sibling tools。Scheduler/RPC 完成使用 `followUp`：忙碌时等待循环结束，空闲时同样启动推理。调用方收口会抑制这条主会话通知。前台结果直接返回，不发送后台通知。

## 会话用量与 Glance

本 fork 的 `reportUsage` 默认**开启**（不同于上游 0.18）。Pi **0.81.0 及以上**会将已收集的子代理花费计入原生会话统计和 Glance：

- 前台：盖在返回最终结果的 `Agent` 工具结果上。
- 后台：启动回执不盖 usage；完成后的 `get_subagent_result` 结算一次。只收到通知、没有收集结果时，父会话统计暂不增加。
- 重复查询和续跑只补尚未上报的 lifetime 增量，包含 cacheRead 和 provider 已报告的费用。

保留 **pi-meter pin**，让子会话实时逐消息记账。Meter 忽略父会话汇总，不重复收费；子消息与历史导入仍按原 session/model 归属。可在 `/agents → Settings` 关闭 **Report usage**（或配置 `reportUsage: false`），只关闭父会话汇总，不影响 pin。

## 引导、续跑与重试

调用 `steer_subagent`，传入原 agent ID 和消息：

| Agent 状态 | 行为 |
| --- | --- |
| 运行中 | 向当前运行追加 steering |
| 排队或初始化中 | 保存消息，等子 agent 就绪后投递 |
| 已完成或 `steered`（软轮次上限） | 沿同一 ID 和上下文启动后台续跑，受并发上限约束 |
| Error、aborted 或 stopped | 拒绝 steering；重试必须显式 resume |

显式续跑时，调用 `Agent` 并传入 `resume: "<agent-id>"`、`prompt: "<后续要求>"`。Resume 默认 **foreground**，即使上次运行在后台。加上 `run_in_background: true` 后立即返回排队/运行状态，并使用与新后台任务相同的自动完成通知、等待和停止生命周期。后台续跑遵守并发上限；前台续跑与首次前台运行一样绕过后台队列。

不传 `resume` 的新 Agent 调用会从头开始，不会继承旧 agent 对话。失败和停止状态绝不自动重试。续跑失败或被停止后，查询仍会显示上一份已完成报告，并明确标注它是历史报告，不是本次续跑的结果。同一 ID 续跑时，不会把上次尚未投递的完成通知当成新结果再次发送。

### 保存的 agent 与仅内存 agent

普通运行默认持久化。可在 agent 文件中设置 `persist_session: false` 改为仅内存运行，或在 `/agents → Settings` 中用 `rememberAgents: false` 修改默认值；显式 `persist_session: true` 可以覆盖该默认值。仅内存 agent 在记录仍保留时可以续跑，但回收或重启后不保证可用。

恢复已保存的终态任务，需要当前父会话分支上符合条件的新格式历史，以及完整的子会话。旧历史仍可查看，但缺少恢复信息时不能通过这些工具续跑。已保存的失败/停止任务仍须显式 `Agent(resume=...)`。

恢复文件缺失或损坏、原工作目录不可用（包括已清理的 worktree）、原模型不可用，都会明确报错，绝不悄悄新建 session 或替换模型。恢复会使用当前安装的扩展和当前凭证；它**不是进程/内存快照，也不是沙箱**。异常崩溃后不持久重放执行中的工作或排队的后续消息，也不保证跨崩溃恰好执行一次。

## 查看进展与设置

打开 `/agents` / FleetView，选择 agent 查看 **Prompt → Usage → Steps → Result**。工具正文默认折叠，失败和轮次上限收尾会明确显示。

| 键 | 操作 |
| --- | --- |
| `Esc` / `q` / `Ctrl+C` | 关闭 |
| `↑↓` / PgUp/PgDn | 滚动 |
| 对话视图中的 `Enter` | 引导运行中的 agent |
| `x` `x` | 确认停止 |
| `o` | 展开/折叠工具参数和结果 |
| 主会话中的 `Ctrl+O` | 展开工具的 Markdown 结果 |

紧凑 lifetime token 数表示 `input + output + cache write`；cache read 保留在完整 Usage 明细中（[上游 issue #38](https://github.com/tintinweb/pi-subagents/issues/38)）。Current context 是上下文窗口占用率，不是 lifetime 总量的百分比。`effort` 是 `thinking` 的展示名称。紧凑进展仅展示稳定的粗粒度阶段，不流式展示路径、命令或 assistant 正文。

在 `/agents → Settings` 管理项目偏好：

- **Worktree isolation：** 默认关闭。关闭时 Agent 工具不提供 worktree 选项，agent 文件、schedule、RPC 的 worktree 请求会在真实 checkout 执行。开启后，下一次 Pi session 会提供 `isolation: "off" | "worktree"`。启用后的 worktree 创建失败会报错，不会降级到 checkout。
- **Pinned observers：** 只有用户拥有的全局配置可以增加 `pi-meter` 等名称；项目只能继承或清空，不能增加观察者。钉住**不是沙箱**：handlers 仍会执行，因此只授权可信观察者。其工具仍受 agent 原有工具策略约束，包括 `isolated` / `extensions: false`。
- **Agent 描述：** 可使用[示例模板](./examples/agent-tool-description.md)定制委派指导。

[配置与集成参考](../../docs/pi-subagents/configuration-and-integrations.md) · [投递与恢复契约](../../docs/pi-subagents/delivery-and-resume.md)

## 许可证

MIT — [LICENSE](./LICENSE) 与 [UPSTREAM_LICENSE](./UPSTREAM_LICENSE)。
