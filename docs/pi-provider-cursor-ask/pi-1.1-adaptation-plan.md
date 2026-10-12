# Cursor Ask：Pi 1.1.0 适配与 usage 契约门槛

状态：待 review，未实施。归属：[总计划](../pi-1.1-implementation-plan.md) W10；用户已冻结 B02，本轮只做本地重放与必要 1.1 兼容，不启动标准 usage 改造、专项回执研究或宿主提案。

## Goal

继续使用 Cursor 专有协议与订阅渠道，正确重放 Pi 的系统/工具变化；保留当前上下文安全策略，不以 Meter 特判改动冻结的 B02。标准账单/上下文分离仅保留为后续参考。

## 可以立即实施：重放与集成兼容

当前 context-usage 将 sections 一直追加，未正确处理同名替换/删除。使用 1.1 的公开 transcript helpers，让请求构造与上下文锚点共享一致的 current system/tools 语义，而不是分别维护两套重放算法。

- 测同名 section 替换、null 删除、content 追加；工具移除、同名重定义；压缩后有效状态与 scope 失效。
- 保留原生 Cursor Connect/protobuf、认证、取消、重试与真实 Run 生命周期，不按通用 OpenAI endpoint 重写。
- 保留当前额度 guest 行为及 cursor-include/cursor-other 来源 ID；B04 已冻结，不为此改变注册协议或修复旧 reload 缺陷。必要兼容不能引入新回归。
- 常规 1.1 provider 流式/事件回归与同类型 options 透传通过；不引入虚拟模型支持。

## B02：标准 totalTokens 恢复的限制（已冻结，仅参考）

已确认的限制：

1. Cursor 现有 receipt 属于累计 server-side Run，只能消费一次；没有已验证逐 inference 回执。
2. Pi 1.1 的 calculateContextTokens 仍使用 usage.totalTokens，且没有独立、可持久化的通用 context observation 字段。
3. provider_stream_event 是观察入口，不会改变宿主压缩/溢出计算。

因此不能直接把 totalTokens 改回累计账单总数；也不能用 tokenDelta 冒充账单，或删除现有窄范围 overflow guard。缺回执必须与确认零费用区分。

### 后续研究路线（本轮不启动）

优先向 Pi 提出并验证通用 context observation 能力：数值来源（测量/估算/未知）、所属请求/模型/有效历史前缀及持久化范围，与 billing usage 独立。上下文显示、压缩触发与 silent-overflow 都读取正确的观察值；压缩、分支、换模型后不能沿用失效锚点，也不能回退到累计 Run bill。

另一条可接受关闭路径是取得并验证真正的逐 inference 计费回执，证明其符合宿主现有语义；不是从文本长度猜出一个数字。

**这不是在本仓偷偷 fork 宿主的授权。** 若需高于 1.1.0 的上游版本、宿主补丁或新依赖，单独呈报范围/版本供用户确认。既定 1.1.0 目标下，无上述能力时 B02 保持 blocked，不把修改 Meter 展示算成标准契约已恢复。

## Contract / Test Impact

| 档位 / 场景 | 预期 |
|---|---|
| T1：section/tool 替换、删除、压缩 | 请求与上下文锚点一致，不残留旧定义 |
| 冻结 B02，仅参考：多次暂停、晚到/重复/缺失回执 | 后续标准账单契约用例，本轮不新增该能力 |
| T1：现有压缩/换模型/tree/resume | 当前上下文安全和 overflow guard 无新增回归，不引入新观察协议 |
| T2：真实协议录制 fixture、取消、重试 | 事件顺序、终态、认证归属正确 |
| T2：quota producer 必要兼容 | 既有功能无新增回归；不以修复已冻结 B04 为本轮验收条件 |

生产认证/额度/推理验证另获授权，CI 不使用真实账号。

## 关闭条件

本轮仅验收重放及必要兼容，B02 原样保留、不勾选，不要求交付上游提案，也不阻塞本轮发布。以后用户重新授权 B02，才按通用上下文通道或可信逐 inference 回执的数值/恢复合同推进。

原始协议依据：[upstream-protocol.md](./upstream-protocol.md#usage-and-context-semantics)。
