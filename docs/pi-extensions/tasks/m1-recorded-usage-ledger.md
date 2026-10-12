# M1：已记录用量账本

依赖 R1 已验收。仅实施 Meter 的 SDK 账本适配；Go 接入留 M2，guest registry/失败空闲重试（B04/B05）、Cursor标准usage（B02）与Antigravity不做。进度在统一执行表维护。

## Goal / AC

以 Pi 1.1 真实持久 entry 为依据，live/import/reload 对同一消耗只计一次；独立 usage（包括未知kind）不能漏账，也不能把缺失费用说成确认零。普通直接调用不依赖 codemode。

1. 计入 assistant、外层 toolResult 的已汇总usage、type:usage及需计入的compaction/branch summary；nested execution事件不再次加到账本。
2. 稳定身份使用真实session/entry身份。相同内容/时间/金额的不同entry仍是不同消耗；同一entry重复读取、live后import或反向顺序不重复。文件名不是新记录的最终session身份。旧账本身份迁移应保守且可解释，不靠数值相等猜测同一请求。
3. 保持 R1 父rollup与子账本只取一次的边界。R1 marker为真实父toolResult.details.subagentUsageRollup，含version=1/agentId/cumulative；这是累计水位，不是可以跨父分支相加的新消耗。缺少子证据、legacy Agent无marker等信息不足场景必须先交接处理策略，不新增猜测型账本归并。
4. 有界增量读取；空闲未变日志和UI重绘不全扫历史，不把 cache-warmer 的entry_appended名称误作pi.on公开事件。手动历史导入可以扫描文件，不能让每帧触发全量导入或网络轮询。
5. 真实已记录0费用与未上报/无效费用区分；保留已知消耗，不用0填出“确认零”或伪造完整度。UI标题/说明表达已记录和未知/不完整，不宣称等于真实账单。
6. 保持既有Consult原始多顾问usage拆分与外层去重，不另造classifier/image逐模型明细框架；本任务不变更账号、认证、套餐余量或网络刷新策略。

## 已定位边界

- `src/ledger/session-parser.ts`：parseSession、usageRecordsFromMessage、usageFromSessionSummaryEntry、recordKey/payloadKey/diffRecords/collapseDuplicateRecords。当前消息来源以时间/responseId或toolCallId标记，summary使用entry ID；parseSession尚不处理独立usage，session header ID尚未作为新身份依据。
- 同文件isSubagentUsageRollup已有子会话canonical策略：Agent结果整体不计，get_subagent_result按version1 marker过滤。不要误以为目前没有去重逻辑，也不要未经分析换成累计水位相加。
- `extensions/meter.ts`：captureMessage/captureSummaryEntry、message_end/compact/tree/agent_settled接线；importHistory传文件basename作为sid。`src/ledger/store.ts`是既有持久层，先复用，不另建账本服务。
- R1代码真源在已验收 `packages/pi-subagents/src/usage.ts`、`usage-reporting.ts`；readSessionUsage是累计快照，UsageReporter按父当前分支claim增量并把marker与native usage一起存入toolResult。消费方不得把累计快照当增量相加。

## 第一阶段：只读接口/身份交接

在实现前回报：

1. 精确1.1公开SessionEntry/UsageEntry形状、真实hook触发时序、何时能够取得最终entry ID；live增量观察方案以及RPC/普通模式无动画时的捕获边界。
2. 新旧记录身份、sid/filename迁移和去重规则；明确如何保留两个相同payload但不同ID的合法记录，及旧ledger缺ID时的可证明范围。
3. parent/child/Consult记录的既有对应证据；列明子日志缺失、legacy无marker时能证明什么。不能仅凭token/cost相等关联父子，也不自行发明跨模型归属或fallback账本。
4. 给独立作者稳定的公开测试入口与SDK fixture事实，然后停止，由协调者固定T0契约后再授权实施。若选中目标与冻结项硬耦合，先报告。

## Contract / Test Impact

独立测试预留 `packages/pi-meter/tests/pi11-ledger.contract.test.ts`（Vitest tests/**/*.test.ts），实现者不得修改。

| 场景 | 预期 |
|---|---|
| assistant0.01＋outer tool0.03＋独立usage0.02 | 已记录0.06；outer内部分解不再叠加 |
| unknown usage.kind，同一个entry反复读取/live/import/reload | 仍计入且仅一次，不因未知kind丢弃 |
| 两条真实entry ID不同、其余payload完全相同 | 两次都计入；不能用相同内容去重 |
| 相同session/entry经不同文件路径或导入顺序观察 | 不多记；legacy迁移须说明能验证的范围 |
| 父分支A、B各有子累计0.06，子后来累计0.08 | 子实际总消耗仍0.08，不把互斥父分支rollup相加；仅有部分来源的策略先冻结 |
| 费用缺失/无效与真实cost=0 | 未知不冒充零，真实0仍可表达；不把token计数当订阅剩余 |
| entries未变＋多次展示，随后新增usage | 不重复全扫；新entry在公开生命周期观察点计入 |
| 普通模式、Consult多顾问/重试与existing import | 无需codemode，不改变既有工具执行或套餐轮询 |

## 允许范围（仅第二阶段解锁后）

Meter ledger/live接线、相关既有测试、必要双语说明与包级文档及独立changeset；不改manifest/lock、Subagents产品代码、统一进度、quota registry/poller或真实全局配置。复用任务专用Herdr worktree/独立Pi会话；精确1.1 SDK，指定PATH与run-isolated，禁止真实模型/额度/MCP请求。读取全局coding与仓库/Herdr规则、测试方法论及相关官方SDK文档完整链接。本地提交允许；push/main/release/关闭issue均未授权。
