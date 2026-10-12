# R1：子代理投递、终态、恢复与费用身份

状态：派发前合同；依赖 E0 已验收集成。任务进度由调度者维护，不在本文件另立账本。

## Goal / AC

让 Pi 1.1 下运行中 steer、结束/取消和恢复都反映真实生命周期，并向 Meter/Glance/父 Agent 提供稳定的已记录费用身份；不因消息回执变化重复执行用户输入或重复计费。

- 对 `queued`、`handled` 与拒绝/异常作真实区分；已处理的输入不得再次排队，已拒绝的不谎称送达，投递尚未结算时不提前释放执行资源。
- SDK 内部 abort 与外部 abort 均反映为取消，但 `agent_settled` 通知不能替代 prompt/abort/idle 的实际结算。取消、完成和排队后继不会跨代串态。
- 合法 retain-none compaction 历史可恢复；损坏 JSONL、缺失引用、非法前向引用或 cwd/ID 错误明确失败，不静默新建会话。
- 计入已定义范围内的 assistant、外层 tool result、独立 usage/summary；同一已持久记录只计一次，nested 事件不叠加外层已经汇总的消费。不能将未知回执当确认零。
- 父工具结果保留 `subagentUsageRollup` 与可恢复水位语义；重复查询/reload/恢复不会重复结算，旧 archive 不让累计水位倒退。

## Design / 边界

优先复用 `packages/pi-subagents/src/agent-manager.ts` 的 settlement barrier/steering 集合、`agent-runner.ts` 的单次执行与恢复校验、`usage.ts` 与 `usage-reporting.ts` 的累计/水位模型。当前 `queueSteer` 假设 Promise<void>，runner 只从 assistant message_end 收 usage，恢复校验默认 firstKeptEntryId 指向已见 ID；这些是本任务核验并适配的具体边界。

保留现有公开 runtime facade 和已支持的恢复语义；确需扩展内部回调时给消费者清楚的记录身份合同，不新造跨包账本框架。相邻调用方、结果展示和 archive 字段按实际受影响范围检查，不用宽泛 cast 或忽略回执消除类型错误。

允许写 `packages/pi-subagents` 中生命周期/恢复/usage 及对应测试、双语文档、独立 changeset；manifest/锁文件归 E0 负责人。不得改 Meter/Glance/Review，不实施权限 hook/factory 装配（R2/R3）、B10 脱敏、B11 双加载警告、B12 schedule/RPC 标签专项。新旧直接/nested权限的最终验收留 R2/R3，不把 R1 宣称为全运行时已适配。

## Contract / Test Impact

T1 状态与恢复；T0 精确用量；T2 真实 SDK 回执/历史适配。复用现有测试与离线 provider，只补回归边界。

| 输入/事件 | 可观察结果 |
|---|---|
| steer queued / handled / rejected / throws | 用户可见状态准确；同一输入不重发，投递 promise 完成或失败后释放 reservation |
| 内部 abort 先发 settled、prompt 尚未完成 | 显示取消意图，但不提前启动会冲突的后继任务或清理 session |
| 旧代迟到 settled/usage 与新代运行重叠 | 不改写新代终态；消费按稳定记录身份计入一次 |
| 正常 session、合法 retain-none、损坏/未知/前向引用 | 前两者恢复；后三者明确失败且无新 session 副作用 |
| assistant $0.01＋outer tool $0.03＋独立 usage $0.02，另有 nested 对 outer 的分解 | 已记录总费用 $0.06，nested 不重复相加 |
| 同一条 usage live 后 import/reload，重复 get | 累计不增加；下一条真实新记录只增加其差额 |
| 父结果已持久 rollup 后恢复或旧 archive 回放 | 水位不倒退，重复查询不再次消费已上报部分 |
| tree 切到不包含原父 rollup 的分支 | 依据当前分支持久证据重建水位，不泄漏其他分支内存 reservation |

### 记录身份与分支数值样本

- 已持久记录按“来源 child session 身份＋宿主可重复恢复的 entry ID”识别，不按消息文本、工具名、读取次数或本次随机 ID 识别。live 与 import 对同一记录必须归到同一身份；旧记录的迁移身份依据目标 SDK 的真实持久化合同补齐，不临时猜测。未持久的重复事件不能绕过去重直接加钱。
- summary 仅计宿主明确记录的“生成摘要本身”的新增消费；对已有记录消费的摘要/累计快照不能再加一遍。独立 usage 的 kind 不认识也不能丢掉其明确上报的消费，但身份和包含关系必须来自目标 SDK 证据，不根据名称猜新费用。
- 费用水位单调性的边界是同一 child 与当前父分支的已确认报告。切树时依据所选分支的持久 rollup 重建，不把另一分支的内存 claim 带过来；两个互斥分支的账不能相加冒充同一次执行消费。

固定样本（单 child，美元）：累计 `0.06` 时在父分支 A 首次 claim=`0.06`，持久 rollup=`0.06`，重复 claim=`0`；切至从报告前分叉、没有该 rollup 的 B，claim=`0.06` 并持久化 B；child 新增稳定记录 `0.02` 后累计=`0.08`；返回 A，claim=`0.02` 并持久化，随后重复=`0`。child lifetime 始终是 `0.08`，不是把 A/B 已报告额相加。现有 `usage-reporting.ts` 的 `UsageReporter.claim(record, sessionManager)` 是父水位行为入口；可按公开方法驱动，不调用其私有清理逻辑。

### 独立测试落地前的接口证据门槛

E0 已交接目标 1.1 证据（路径相对任务 node_modules/@earendil-works/pi-coding-agent）：公开 `AgentSession.steer/followUp` 在 `dist/core/agent-session.d.ts:555–568` 返回 `Promise<"handled" | "queued">`，拒绝通过 rejection 表达；别名不由根入口直接导出，按公开方法返回值推导即可。公开 `AgentSessionEvent`/`AgentSettledEvent` 包含 aborted，声明见 `dist/core/agent-session.d.ts:54` 与 `dist/core/extensions/types.d.ts:777`。用公开 `SessionManager.appendCompaction(summary, null, tokensBefore)` 生成合法 retain-none fixture（`dist/core/session-manager.d.ts:271`），持久 firstKeptEntryId 等于该 compaction 自己的 ID，不依赖先前 message；不可把这当任意前向引用许可。R1 在写实现前提交沿用的公开 facade 导入路径、投递/取消/恢复入口、可观察状态以及可控离线 provider 的结算方式。调度者将这些具体路径/样本固定给测试作者后，才进入独立测试编写；不是让测试作者阅读新实现猜接口。此补齐不改变上述用户行为合同，也不要求 E0 提前修好 R1。

独立测试作者先按固定合同编写高代价用例，不读待测新实现；调度者将测试与实现组合到候选验收树后验证。真实模型/账号不用于这些测试。

## 派发与交付

先读取全局规则（`/root/.agent-vm-state/pi/agent/AGENTS.md`、`/root/.agent-vm-state/pi/agent/rules/coding.md`、`/root/develop/AGENTS.md`）及任务 worktree 的 AGENTS.md，完整阅读运行时计划、E0 失败归属与目标 1.1 SDK 文档/相关链接。先回报 cwd/origin/base/允许写范围再编辑。

交付本地任务提交、测试实际结果、用于消费者的费用身份与终态合同说明；不 push/main merge/release，不编辑全局进度表。若需要修改冻结项或扩大公共协议，停止相关部分并报告调度者。
