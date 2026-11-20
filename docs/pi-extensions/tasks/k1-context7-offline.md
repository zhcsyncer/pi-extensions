# K1：Context7 双入口离线兼容与消费者合同

状态：派发前合同；依赖 E0 已验收集成。此任务不连接真实 Context7、不读凭据、不修改用户 MCP/profile 配置。

## Goal / AC

让旧 REST 扩展用户保持原体验，同时为选择 Pi 原生官方 Context7 MCP 的用户提供正确指导和可信的授权接入合同；不给 Plan/child 提供依赖工具名前缀的宽泛授权，也不重写 MCP 客户端。

- 旧包、REST、配置、依赖入口和 bundle 默认加载方式保留；支持目标 Pi 1.1，未配置 MCP/codemode 的用户仍可直接查询。
- skill 根据实际可用工具指导使用旧扩展或原生 MCP，保留 resolve→query、已给 library ID 可跳过 resolve、每种工具最多三次、查询不含敏感信息等原约定；不把候选 MCP 名称写成已真实握手确认。
- MCP direct 不依赖 codemode；脚本能力由用户另行启用。不得自动改 mode/defaultTools/tool_search，不新增执行别名或 MCP wrapper。
- 为 R3/P1 定义最小的服务来源/连接配置/具体工具身份合同，支持离线 transport 模拟声明；可信来源与工具名分别核验，不把 `mcp__context7__*` 或 builtin:mcp owner 当全部授权依据。
- 本地切换/回退的双语用户说明清楚：仅用户选定 profile 停旧查询入口，保留旧实现和 skill；不删凭据或强迫所有用户迁移。真实名字/schema与账号冲突留 L1 验收。

## Design / 写入边界

主要写 `packages/pi-context7` 中必要兼容代码、`skills/context7-docs/SKILL.md`、对应测试与双语 README；不改 Plan/Subagents/Tool Display 的实现。消费者合同通过现有包级规格中的精简约定或交付回复给调度者确认，不建立新公共授权框架；总计划/进度仅调度者维护。

保留工具实际返回的文本/结构契约，旧 REST 文本不是 MCP CallToolResult；显示联验归 D/I1。依赖变更请求交 E0，不单独改锁文件。若没有生产兼容改动需要，以真正的离线行为验证交付，不为产生 diff 做重构。

## Contract / Test Impact

T2 为真实 SDK 的旧工具注册与离线 transport；T1 为可信身份/来源冲突规则的消费者合同（本任务定义及验证样本，不跨包实施授权）。纯 skill 文案不做字符串自证测试。

| 场景 | 可观察结果 |
|---|---|
| 只加载旧扩展，无 MCP/codemode | 原 resolve/query 可直接调用；配置、错误及取消无新增回归 |
| 离线官方 MCP 风格声明，只有 direct | 指导与工具实际声明匹配；不要求额外脚本 runtime |
| 配置允许 server A 的两工具，另有同前缀/同名但来源不同的 server B | 提供给消费者的测试合同明确只允许 A 的获批工具，不能因名字相似扩权 |
| 未提供/未知/晚到工具声明 | 不编造工具名或扩大白名单；待真实声明核验 |
| 已存在不同 URL/认证拥有者的同名配置 | 后续 live 操作必须停止确认，不能覆盖/搬密钥；本任务只用合成样本 |
| 本地切换与回退指导 | 旧包和配置保留，单一活动查询入口，不停用其他 bundle 扩展或 skill |

使用 E0 的隔离 agentDir 与脱敏/合成 fixture；真实连接、401/429、取消及大结果行为最终由 L1/I1 补齐。不能把模拟成功写成真实服务已可用。

## 派发与交付

读取 `/root/.agent-vm-state/pi/agent/AGENTS.md`、`/root/.agent-vm-state/pi/agent/rules/coding.md`、`/root/develop/AGENTS.md` 与 worktree AGENTS.md，完整阅读 Context7 规格及目标 Pi MCP/SDK 的相关官方文档。先回报 cwd/origin/base/允许写范围。

交付本地 commit（如有）、离线验证、R3/P1 可用的明确合同与仍需真实核验的事实。不得 push/main merge/release，不停用真实旧入口，不使用真实账号查询作为单元测试。
