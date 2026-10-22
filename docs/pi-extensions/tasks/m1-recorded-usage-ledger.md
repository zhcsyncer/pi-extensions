# M1：已记录用量账本

## 当前授权：仅修正两个边界（2026-10-21）

三模型审阅及顾问后，用户授权保留统一捕获，不改成事件优先双路径；只做以下两项，不把历史267通过当成这次验收：

- 数组/对象旧账的无效负费用不再拖低已知小计与预算，仍计未知；已知零、正常正费用及已有正分项小计语义保持。只在读取时处理，不能改写原账本。
- 使用真实SessionManager、只暴露Readonly接口，验证缺少额外计数方法时的分支补读。覆盖追加后切别的旧分支、追加后回同一旧leaf、正常顺序追加以及重复捕获。有失败才最小修正，不预先认定比较lastLeaf就足够，也不扩展新框架。

独立合同预留`packages/pi-meter/tests/pi12-recorded-boundaries.contract.test.ts`，先保留基线原红，再验最小实现。实施者不读改独立合同；作者仅据合同/公开签名设计，不读实现及作者测试。已有独立合同继续原样执行。

用户认可未知不能冒充确定零，不做缓存预热专项追踪、空闲轮询或非标补算；已有标准usage仍读。文案、零值显隐、分项合计策略、计价、认证及quota不在本次修改范围，不能由两项修正通过自动推成Meter整包确认。

本次交付6be878c：两处费用读取判断和3行捕获回退，不改原账本。真实SDK1.2独立基线4失败/7通过（负值2、跳分支2）变为11/11；两种旧格式、原账本字节、正常正值/已知零/正部分小计均验证。相同源码另在实际1.3运行，两个版本Meter各278/278，源码与新合同类型均通过。未做真实账本/在线计费或全仓34矩阵。缺计数接口且采集间改变分支是验证条件，不宣称默认Pi界面已发生漏账。原夹具接口修正、类型导入错误、pnpm解析错版本及1.3测试入口错误单独保留，不混作产品失败；证据见`/var/tmp/pi-meter-boundaries/`。

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

## 最新范围收敛：不为旧账建立新系统

用户再次要求不要过度防御并继续推进。M1不以任意历史日志的完美对账为前置：保留既有子账本为准的口径和旧格式兼容能力，只补正常SDK1.1流程的最终持久值、独立usage、新entry身份及幂等捕获。不删除/重建旧账，不加provisional替换、复杂未决证据存储或全局来源证明框架。

明确sourceId及实际读取文件alias可以使用；不得把内容/金额相等当新身份。若沿用已有legacy兼容匹配，要限制在旧兼容路径并说明其既有局限，不能用于新ID之间或误抵扣只含新tail的live记录。正常fork来源与结构按实际SDK事实处理；不拿timestamp单独证明，也不为恶意手改、理论碰撞等额外场景设计新协议。不可确认的情况报告统计范围/局限，不冒充确认零或全历史已精确修复。

作者简化方案已交，协调者采纳以下非破坏性默认行为。历史重建/新的对账产品不纳入，不要求用户为了必要SDK适配先选迁移方案；实际第二阶段开始以统一表派发为准。

- 新记录使用真实header/getSessionId＋entry ID；Consult拆分用原始raw下标，不能用过滤后序号或payload作为身份。不同新ID即使其他字段相同也分别计入。
- 启动读一次现有entries，之后在公开turn_end、agent_settled、compact/tree及必要命令/退出边界观察新增持久entries；不把message_end的中间值立即入账，不在render扫描或新增空闲轮询。父链/entry ID用于增量与分支切换，不依赖不存在的pi.on(entry_appended)。
- 保留旧文件/行和原有预算口径；不为新身份做批量重写、压掉旧行或改变旧金额。若现有读侧有旧格式去重，保持其口径，不因取消磁盘重写反而把旧重复行计入预算。
- 明确sourceId及实际已读文件的basename↔header alias用于旧兼容。legacy payload匹配若保留，仅在完整来源快照对无新身份旧行一对一兼容；新ID先精确匹配，已观察新身份供后续live使用，新增tail不反复消耗legacy抵扣额度。不要把旧兼容夸成完美迁移。
- 正常fork/clone沿parentSession读实际源header，核对保留ID与复制分支结构（含label/父链重连），识别复制部分；canonical归属使用来源事实，不只改key却把旧消费归给新项目。普通Subagents父链接本身不算复制，无关session各自计入，来源缺失不猜。复用现有import/capture边界，不建全局证明库；纯内容parser不必承担隐式文件IO。
- 子账本可加、父rollup不叠加，保留现有口径；仅有部分子记录不声称全覆盖。保留已知小计，费用未知不冒充确认零。
- 不恢复旧逻辑已合并掉的行、不回填无法对应的旧捕获值，不承诺缺来源历史的精确归属；UI只表达已记录费用及必要局限，不另造分类账产品。

## 第一阶段：只读接口/身份交接

在实现前回报：

1. 精确1.1公开SessionEntry/UsageEntry形状、真实hook触发时序、何时能够取得最终entry ID；live增量观察方案以及RPC/普通模式无动画时的捕获边界。
2. 新旧记录身份、sid/filename迁移和去重规则；明确如何保留两个相同payload但不同ID的合法记录，及旧ledger缺ID时的可证明范围。
3. parent/child/Consult记录的既有对应证据；列明子日志缺失、legacy无marker时能证明什么。不能仅凭token/cost相等关联父子，也不自行发明跨模型归属或fallback账本。
4. 给独立作者稳定的公开测试入口与SDK fixture事实，然后停止，由协调者固定T0契约后再授权实施。若选中目标与冻结项硬耦合，先报告。

## 独立测试公共入口

既有接口保持可调用：`parseSession(content:string,sid:string):ParsedSession`返回`{cwd,sid,records,skipped}`；`usageRecordsFromMessage(message,{sid,cwd})`、`usageFromSessionSummaryEntry(entry,{sid,cwd})`；`recordKey`、`diffRecords(existing,incoming)`、`collapseDuplicateRecords(records)`。旧sid参数可作旧格式fallback/已读文件alias，新记录身份优先真实header。

`src/ledger/store.ts`导出`createLedgerStore(agentDir?) -> Promise<{store,migration?}>`、`FileLedgerStore`、`serializeUsageRecord`、`parseUsageLine`；store的公共`append(record):Promise<boolean>`与`readAll():Promise<UsageRecord[]>`。`UsageRecord`从ledger/types.ts导出，现有cost/costKnown表达数值及是否已知；未知可保持数字占位但不能被当作确认零。新身份字段允许可选追加，先交精确类型而非让独立作者读实现。

真实live/import测试加载`extensions/meter.ts`并通过真实SDK SessionManager/公开事件驱动；公开命令是`/usage import`（不是/meter），使用临时agentDir、空凭据/断网，不用真实账本。若需要新可选参数或初始化事实，先交协调者给独立作者，禁止私有测试开关。

## Contract / Test Impact

独立测试预留 `packages/pi-meter/tests/pi11-ledger.contract.test.ts`（Vitest tests/**/*.test.ts），实现者不得修改。

| 场景 | 预期 |
|---|---|
| assistant0.01＋outer tool0.03＋独立usage0.02 | 已记录0.06；outer内部分解不再叠加 |
| unknown usage.kind，同一个entry反复读取/live/import/reload | 仍计入且仅一次，不因未知kind丢弃 |
| 两个正常store实例向同一临时账本追加同一新身份 | 复用现有写入锁，仅一次有效追加，不为此建分布式框架 |
| 两条真实entry ID不同、其余payload完全相同 | 两次都计入；不能用相同内容去重 |
| 相同session/entry经不同文件路径或导入顺序观察 | 不多记；legacy迁移须说明能验证的范围 |
| 父分支A、B各有子累计0.06，子后来累计0.08 | 子实际总消耗仍0.08，不把互斥父分支rollup相加；仅有部分来源的策略先冻结 |
| 费用缺失/无效与真实cost=0 | 未知不冒充零，真实0仍可表达；不把token计数当订阅剩余 |
| entries未变＋多次展示，随后新增usage | 不重复全扫；新entry在公开生命周期观察点计入 |
| 普通模式、Consult多顾问/重试与existing import | 无需codemode，不改变既有工具执行或套餐轮询 |

## 允许范围（仅第二阶段解锁后）

Meter ledger/live接线、相关既有测试、必要双语说明与包级文档及独立changeset；不改manifest/lock、Subagents产品代码、统一进度、quota registry/poller或真实全局配置。复用任务专用Herdr worktree/独立Pi会话；精确1.1 SDK，指定PATH与run-isolated，禁止真实模型/额度/MCP请求。读取全局coding与仓库/Herdr规则、测试方法论及相关官方SDK文档完整链接。本地提交允许；push/main/release/关闭issue均未授权。
