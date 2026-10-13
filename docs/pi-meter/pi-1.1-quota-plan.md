# Meter：Pi 1.1.0 账本与额度实施规格

状态：M1账本适配已验收并集成；Glance用量/主题与Go来源尚未验收，实际进度见[执行表](../pi-extensions/pi-1.1-execution-plan.md)。归属：[总计划](../pi-1.1-implementation-plan.md) W7/W8。本轮只做 SDK 账本适配与 B03 / issue #152 的 Go 部分；用户已暂缓 Antigravity，不调查、不实现、不阻塞本轮发布。B04/B05 已冻结，不修旧 guest 注册表或新增空闲重试。相关设计只留作参考；若 #152 对它们形成硬依赖，先报告冲突并暂缓受影响部分。Cursor 标准 usage 的 B02 也已冻结，见[其计划](../pi-provider-cursor-ask/pi-1.1-adaptation-plan.md)。

## Goal

适配 1.1 的已记录消耗与账号额度分账，接入 #152 的可验证新来源；未知/无权限不能伪装成零用量。新来源满足自己的 reload/错误合同，旧来源不引入新回归，但不承诺本轮修好既有 B04/B05。

## W7-A：guest 注册生命周期（B04 冻结，仅参考）

当前 Map 随模块重载，旧 global host 却可能继续接受注册。改为进程级稳定 registry，按 ID 更新；新旧 host 通过 live 容器访问，初次迁移吸收旧 host 的 list 与 mailbox，并转接可达旧 host 的注册入口。

自己的 guest 每次解析当前 host，不缓存失效的 register；保留 Meter 未加载时的 mailbox、内置来源保护和匹配优先级。不引入磁盘注册表/daemon，不把适配器闭包绑定到错误会话的鉴权。

**AC**：guest 在 Meter 前/后加载、resetModules/reimport、旧 host 再注册、同 ID 更新、重复安装都可解析当前来源。真实 Cursor 当前 ID 为 `cursor-include` / `cursor-other`；BACKLOG 中 `cursor-api/auto` 是旧称，不按旧称改回实现。

## W7-B：只恢复失败快照，不恢复健康网络轮询（B05 冻结，仅参考）

- 30 秒状态 poll 先重读共享缓存。仅当前 preferred guest 的失败快照满足最小间隔后，调用现有刷新入口，限定该来源。
- 本进程 single-flight；切模型、reload/shutdown 后不写旧 UI；成功后恢复只读缓存。
- 健康快照超过 TTL 不因此触发定时网络轮询；未登录不反复交互认证。现有 provider 管理的合法非交互刷新仍由认证拥有者执行。
- 新来源明确未登录、无订阅、限流/临时失败、解析失败、陈旧；必要时扩充可选错误类别，保留旧 adapter 兼容，不靠错误文案猜零额度。
- 遵守跨进程共享 lastAttemptAt；这不是严格分布式互斥。保留既有允许短暂双拉的契约，不把原子 rename 当跨进程锁。

**AC**：失败到期可恢复，无需新 turn；他进程尝试/成功会影响本进程决策；慢请求与重复 tick 不重叠；健康、未登录和内置来源行为不意外改变。

## W7-C：完整解析已上报的用量

Meter 与 Glance 补 `type: usage`，包括未知 kind；按稳定 entry ID 幂等汇总，live/import/reload 使用一致身份规则。使用公开 session entries 和有界增量扫描，不每个动画帧扫历史；cache warmer 的 entry_appended 不是可直接注册的扩展 pi.on hook。

账本计算合同：assistant + 外层工具已汇总 usage + 独立 usage/需计入的 summary；nested execution 事件不再相加；父 Agent rollup 与子会话账本只记一次。首期不拆分 classifier/image 的逐模型内部明细。

没有上报的费用不得推定为确认零；标题和说明区分“已记录”与未知/不完整。Cursor 的 totalTokens/context 分离不能靠 Meter 专属特判宣称解决。

## W8：issue #152 本轮仅 Go，Antigravity 暂缓

沿用 `QuotaAdapter` 的来源、匹配、fetch 与 `QuotaSnapshot` 的窗口/错误/时间契约。不要新增模型执行 provider；不要从本地 token 总数推算订阅剩余。

### OpenCode Go：可以进入实现，但先过 schema 门槛

精确 Pi 1.1.0 已验证：

- Go 的 provider ID 是 **`opencode-go`**；Zen 是 **`opencode`**。不得混为一个 ID。
- 两者共享环境变量名称 `OPENCODE_API_KEY`，不代表相同配额或权限。
- 复用 Pi 的 provider 认证解析入口，不另存凭据；不要凭第三方教程假定 Pi auth.json 键或读取 OpenCode 客户端的私有文件。

第一方端点为 `GET https://opencode.ai/zen/go/v1/usage`，Bearer API key。它存在于官方源码，但不是承诺稳定的公开文档契约。

**已知协议变化必须纳入测试**：

- 合并提交 `2b8a596` 返回顶层 `useBalance/rollingUsage/weeklyUsage/monthlyUsage`，窗口含 `usagePercent/resetInSec`。
- `d4704347465c1ee63d0c213ed00e648e7f0231c5` 改为 `usage.rolling/weekly/monthly`，窗口含 `status/percent/resetsAt`；后续还出现 `proxyInference`。
- 实施先核对当时第一方版本与脱敏实际响应。只支持明确验证的形状；旧形状要么有显式版本 parser 和 fixture，要么报不支持，禁止混猜字段。
- 接收合法的正常及额度耗尽状态；未知状态/缺字段报未知，不补零。401 与 403 分别表达认证失败、无 Go 权益；429/5xx 保留暂时失败语义。
- `percent` 是已用比例。**不能统一规定 0% 就丢弃 reset**：它可能是取整，也可能是无使用的 rolling 占位窗口；weekly/monthly 又有不同周期。保留有效的上游重置时间，并记录已确认的窗口语义。

### Antigravity：本轮暂缓，以下仅供未来重新授权后参考

用户已决定先不处理 Antigravity。以下发现任务、证据门槛与接入方案本轮均不执行、不验收，不作为发布阻塞；Go 完成后仍保留 #152 的未完成诉求。

Pi 1.1.0 无内置 Antigravity provider。issue 未说明具体社区包、认证拥有者、账号/项目选择和额度出口；不同实现不能共用猜测的 token 路径。

此外，官方个人版附加条款第 6 条限制第三方软件访问服务，并列明停用账号风险；页面同时列出某些企业接入不适用该条款。**先确认接入形态、适用条款及允许的数据出口**，不得把社区逆向端点作为默认受支持 API，也不得把所有企业情形一概判为禁止。

发现任务必须产出：

1. issue 作者实际 provider/package/version、账号类型、认证/刷新归属；只收非秘密元数据。
2. 可用且适用的数据来源、脱敏样本、已用/剩余方向、重置及模型共享池关系。
3. 对接方式：优先由既有集成提供允许的 quota source/guest adapter；不自行扫描 IDE 数据库、复制 OAuth token 或新增逆向登录/刷新。

未取得允许且可验证的数据源时保持“未支持/需确认”，给出具体缺口。若最终不可支持，须经用户/issue 作者确认明确的范围处置；**不能以只完成 Go 或显示占位符关闭整个 #152**。

## Contract / Test Impact

| 档位 / 输入 | 预期 |
|---|---|
| 冻结 B04，仅参考：guest 先后加载、旧 host | 后续目标是修复旧注册；本轮不重构注册表 |
| 冻结 B05，仅参考：失败空闲重试/共享间隔 | 后续目标是自动恢复；本轮不新增网络重试 |
| T1：新来源未登录、取消/shutdown、已有刷新路径 | 不弹登录、不回写旧 UI、不改变旧来源轮询策略 |
| T0：assistant $0.01 + outer $0.03 + usage $0.02 | 已记录费用 $0.06；outer 的 nested 分解不再叠加 |
| T0：父 rollup 与子账本、重复导入 | 消耗恰好一次，记录水位单调 |
| T1：Go 新/旧/未知 schema、正常/耗尽 | 只解析已支持结构；未知不补零 |
| T1：used 20%、remainingFraction 0.8 | 均表达已用 20%，只有确认该方向的数据源才转换 |
| T1：0% 有真实 reset、rolling 无使用、缺 reset | 不无差别丢时间或伪造周期 |
| T1：共享池多个模型、不同账号 | 同池不重复，跨账号不复用错误缓存 |
| T2：401/403/429/5xx、畸形 JSON、过期快照 | 认证/权益/暂时失败/未知/陈旧可区分，日志脱敏 |

单元和 SDK 集成使用脱敏/合成 fixture、假时钟及离线 transport；不在 CI 调真实额度。上线验收由有相应订阅且授权的账号执行；显示时间用本地格式。

本轮 W7 仅实施 C；W8 仅接入 Go，Antigravity 暂缓，不能借机解冻 A/B。若现有机制无法满足新来源的 reload 合同，报告依赖冲突，不暗中修旧存量、不降低验收或另造平行注册机制规避确认。未启用 codemode 的普通账本/额度路径同样必验。

## 证据

- [OpenCode #16513](https://github.com/anomalyco/opencode/pull/16513)
- [合并版 Go route](https://github.com/anomalyco/opencode/blob/2b8a596/packages/console/app/src/routes/zen/go/v1/usage.ts)
- [后续响应重构](https://github.com/anomalyco/opencode/blob/d4704347465c1ee63d0c213ed00e648e7f0231c5/packages/console/app/src/routes/zen/go/v1/usage.ts)
- [当前 route](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/usage.ts) 与 [窗口计算](https://github.com/anomalyco/opencode/blob/dev/packages/console/core/src/subscription.ts)（动态来源，实施时重核）
- [Pi 1.1.0 Go provider](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/src/providers/opencode-go.ts)
- [Antigravity 官方条款](https://antigravity.google/terms)（动态政策，实施前按具体接入复核）
