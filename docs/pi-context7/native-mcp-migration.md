# Context7：本地接入官方 MCP，旧扩展暂时保留

状态：离线 K1 已交付并集成；真实 profile 接入及跨消费者联验仍未执行，统一进度见执行编排 §0。归属：[总计划](../pi-1.1-implementation-plan.md) W5。用户已确认不必同时删除或退役旧扩展；此前删除 REST/client/schema、依赖与入口的方案撤回。

## Goal / 已选方向

用户在自己的 Pi 配置中使用官方 Context7 MCP，不再依赖旧 REST 扩展执行查询。**这是本地接入方式的选择，不是所有用户的强制迁移，也不是重写一个 MCP 客户端扩展。**

Pi 提供的是 MCP 客户端能力，Context7 官方提供服务；仍须配置 server 及按需鉴权。原生支持 MCP 不等于已自动连接 Context7。

- 本地采用 MCP direct，两工具直接可见；不开 codemode 也能用，用户启用后再验证脚本路径。
- 不自动开启 codemode/tool_search，不改其他用户的模式或 server 配置。
- 旧 `pi-context7` 包、REST 实现、依赖入口、配置与 skill 暂时保留，只做必要的 1.1 兼容；继续使用旧扩展的用户不被迫切换。
- 不新增 MCP 封装层、不改成 skill-only 包、不新增可执行工具别名，不借此删除代码或改根 bundle 的默认加载方式。

## 本地接入步骤（配置变更另获授权）

1. 在实际使用支持原生 MCP 的 Pi 环境配置官方 Context7 server，复用已确认的现有认证路线；不静默切账号或顺手切 OAuth。不要把当前分析环境与用户其他机器的配置混为一谈。
2. 独立验证连接、实际工具名/schema、错误/取消和直接查询。候选名为 `mcp__context7__resolve_library_id`、`mcp__context7__query_docs`，以实际声明为准；多出的工具不自动纳入本轮。
3. 验证新路径后，在**该用户 profile**排除旧 Context7 extension 入口，避免同时暴露两套同功能工具。根 bundle 用户只排除 Context7 那个入口，不停用整包，也不一并排除 skill。
4. 旧实现、配置和凭据不删除；需回退时恢复旧入口并停用本地新 server，仍保持单一活动查询入口。

server/个人凭据留在用户配置，项目只写必要的受信覆盖。同名不同 URL、项目替换连接参数、认证冲突时停止确认；不得自动搬运密钥到项目、报告、日志或测试快照。

## 与扩展适配相关的必要联动

- **skill**：保留 resolve→query、给定 library ID 可跳过、每种工具最多三次、查询不含敏感信息等约定。按会话实际工具更新指导；共享 skill 仍兼容旧扩展与官方 MCP，不把所有用户绑定到一组新名称。
- **Tool Display**：验证旧 REST 与 native MCP 两种工具的展示和历史；按各自返回契约处理，不把旧文本当 MCP CallToolResult，也不为显示添加执行别名或重执行历史。
- **main Plan**：保留原 Context7 只读工具的正常使用，并对已核验 native Context7 的两个工具补精确授权；不能只替换掉旧白名单导致普通用户回归，也不放行任意 MCP。
- **SDK child**：主会话配置好不等于 child 自动可用。按用户选择与会话授权装配需要的 MCP 能力；旧扩展模式仍正常，isolated/reviewer 不扩权。详见[运行时规格](../pi-subagents/pi-1.1-runtime-plan.md)。

这些是既有运行时/显示/指导的适配，不是重新实现 Context7 的 MCP 连接和认证。

### K1 交接给 R3/P1 的可信身份合同

授权需绑定可信 profile/session、有效连接配置及其来源、server 与认证拥有者，再匹配实际声明的原始工具名、Pi 注册名和 schema；本轮仅 resolve/query 两项。名字/前缀相似、同样宣称只读不继承授权，未知/晚到/变更声明在核验前不放行。`builtin:mcp` owner 和 `getMcpServers()` 视图单独不足以证明可信来源；缺少绑定证据时不能猜测放行。

R3 在建立连接前过滤未授权 server，隐藏工具不等于连接授权；isolated/reviewer 不扩权。P1 保留旧 REST 的精确授权，再接入已核验的 MCP 身份，不替换成宽泛前缀白名单。K1 的合成 transport 特意连接两个来源以观察元数据差异，**不是**消费者拒绝未授权连接的验收证据；该拒绝行为由 R2/R3/P1 各自实现并联验。

## AC / Contract

| 档位 / 场景 | 预期 |
|---|---|
| T2：用户只用旧 REST 扩展、无 MCP/codemode | 旧工具在支持的 Pi 版本正常，不要求配置官方 server |
| T2：本地只用官方 MCP direct、无 codemode | 两工具直接可用，不加载旧执行入口也不影响其他扩展 |
| T2：用户启用 codemode | 在授权范围内使用 MCP 返回契约，直接调用仍正常 |
| T1/T2：skill、Plan、SDK child 的两种接入 | 指导及授权匹配实际来源，旧模式不回归，新模式不扩权 |
| T2：实际握手、401/429、取消、大结果 | 名字/schema核验，错误可恢复，截断明确 |
| T1：已有 server/凭据冲突 | 不覆盖，不泄密，不自动改认证路线 |
| T2：本地切换、回退、reload、旧历史 | 单一活动入口，历史可读，无删除或重执行 |

本地接入可以独立验证，不以删除旧包或完成全部 UI 重构为前提。子代理/Plan/统一显示的完整交付仍与 W1–W3 联验。K1 已完成离线指导与 SDK 注册/调用兼容验证；未配置真实 server、读取真实凭据、停用入口或删除旧实现。合成工具声明不代表真实 Context7 名字/schema 已握手确认。
