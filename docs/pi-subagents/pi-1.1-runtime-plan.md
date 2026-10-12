# Pi 1.1.0：子会话、工作流与权限实施规格

状态：分阶段实施中，验收状态见[统一执行表](../pi-extensions/pi-1.1-execution-plan.md#0-统一进度表调度-session-唯一写入)。归属：[总计划](../pi-1.1-implementation-plan.md) W1/W2；用户已冻结 B10–B12，本轮不实现或专项复核这三项，以下对应段落仅留作参考。

## Goal

普通任务不依赖 codemode 也能完整运行；用户选择启用时支持被授权的脚本与 Context7 MCP，同时不扩大 isolated/reviewer 或 planning 权限。投递、取消、恢复和计费在两种模式都正确，不由扩展擅自改用户配置。

## 来源与范围

- 发布基线为 main `f48a91b`。2026-10-10 的全局配置已排除 bundle Plan、worktree Plan 和 Junie；不再把 10 月 8 日审计的“活动 Plan”当当前状态。
- main Plan 已拒绝 Agent/codemode；Explore/Plan relay 是 `feat-plan-mode-subagent-explore` 未合入功能。默认不随升级引入 relay，也不携带其 0.84 SDK 和五条测试债务。
- 若另行批准 relay，须先审阅工作树差异并建立不可被角色配置覆盖的只读 child ceiling；这是新功能安全前置，不是 main 已有 relay 的 bug。
- 当前排除设置不自动改变。包适配、合入工作树与用户重新启用扩展是三件事。

## Design：三个不同的边界

### 1. 工具入口

实际注册定义设置 `exposure: model-only`：Todo、Question、Consult、submit_plan、complete_plan、Agent/get/steer，以及整个 herdr_process。不要修改 `getAllTools()` 元数据副本。

普通 I/O、Search Hub、旧 Context7 扩展保持直接调用；本地官方 Context7 MCP 采用 direct。旧扩展不退役，按用户实际选择提供入口；原 sequential、审批、预算和取消规则不变。model-only 只禁止工具内部调用，不保证模型一个 batch 只发一个顶层调用。

### 2. 会话级能力策略

用现有 runtime/manager 的策略承载权限，不把 active 工具集合当授权。对工具执行至少固定：builtin 精确集合、扩展来源/工具子集、允许的 MCP server/工具、codemode 开关与 pins。

- 通过 child inline extension 的 `tool_call` 检查覆盖顶层、多层 nested、晚注册；不再只替换 `agent.beforeToolCall`。
- 普通 child 根据用户/会话配置及授权分别装配 codemode/MCP factories，不能从作者本地偏好推导所有 child 默认开启；MCP direct 可独立装配且无需 codemode。本轮 child 默认方案不引入 tool-search factory，不等于关闭主会话已有的 tool_search。isolated/reviewer 不装配 codemode/MCP，format-repair 保持空工具。
- 未授权 MCP 不建立连接、不枚举资源、不执行工具。配置 server 与后续扩展注册的 server 都须过滤；只筛 `loadConfig` 不够。
- `mcp__*` 不覆盖三个资源工具。首期 child 无资源需求则拒绝 `list_mcp_resources/list_mcp_resource_templates/read_mcp_resource`；有需求再定义精确范围。
- MCP 工具共享内置 loader owner，不能据 `builtin:mcp` 就允许所有 server。用可信配置来源、规范化身份、连接配置及精确工具名绑定授权，不信任同名前缀或未经验证的 readOnlyHint。
- Pin 只保观察者加载，不授予工具或 MCP 连接。可信扩展本身与宿主同权限，本方案不是恶意扩展的 OS 沙箱。

仅将确实影响权限/运行决策的可变配置绑定 runtime；双 runtime 回归定位并消除实际串态点，不发明全仓通用上下文框架。Search Hub 的跨会话配置串用修复已由用户暂缓，不在本轮实施；若与已选能力形成硬依赖，报告冲突，不自动解冻。

### 3. 恢复与账本

- recipe 保存策略版本和非秘密身份；恢复时与当前授权相交。旧授权被撤销后不得凭历史恢复更大权限。
- 合法 retain-none compaction 自指应通过；损坏、未知 ID、非法前向引用应明确失败，不静默创建新 session。
- 子会话 lifetime 覆盖已定义需计入的 assistant、外层 toolResult、独立 usage/summary，按稳定记录身份增量结算。
- 父 `subagentUsageRollup` 与 Meter 子账本只取一次；不把 nested events 加到外层已汇总 usage 上。

## W1：Subagents 必要适配与冻结参考

### 真实投递与终态

- 接收 `QueuedInputDisposition`：queued 与 handled 分开；handled 不自动重发、不谎称入队。
- 观察 `agent_settled.aborted` 补足 child 内部取消，但仍等待实际 prompt/abort/idle 完成再清理或调度下一项。
- 保留代次隔离、settlement barrier、deferred 通知以及失败/超时后恢复策略。

### B10：折叠活动脱敏（冻结，不实施）

默认只显示安全摘要，例如可执行文件名、隐藏参数或去敏 URL；覆盖常见 bearer/token/password/authorization、URL userinfo/query secret。完整参数只在明确展开后显示，终端控制字符仍须清理；不改变真实成功/失败状态。此目标是减少默认展示泄露，不宣称识别一切秘密。

### B11：重复加载检测（冻结，不实施）

识别 upstream 与 fork 的同名 Agent/FleetView 注册，警告列出两包但不崩溃。不得把自身 reload、合法 child/runtime 或单包多次查询误判为重复安装；不能为检测而覆盖别人的注册。

### B12：schedule/RPC invocation（冻结，不实施）

现有 manager 已有 fallback invocation/effective identity，不另造平行字段。补齐请求配置→实际模型/effort→archive→get_result chips 的全链路；配置模型无法解析时，不以请求值伪装实际结果。

## W2：Review 与轻量工作流包

- **Review**：锁定已修复的 Subagents runtime 依赖，在真实打包安装中验证，消除 embedded 0.2.0 与 bundle 0.2.3 分裂。external-v3、探测超时/不兼容 fallback 到 embedded 分别测；执行已开始后失败不得再次 fallback 双跑。保持物理 reviewer 独立性、证据冻结及只读工具范围。
- **main Plan**：submit/complete model-only；审批、hash/revision、terminate、tree/reload 不变。保留原 Context7 工具授权，对已核验 native Context7 两工具补精确授权；按实际来源识别，不删除旧模式支持、不放行任意 MCP。planning 保持拒绝 Agent/codemode，normal 才可脚本编排。
- **Todo**：保持现有 checkpoint 格式和有界生命周期，只收紧嵌套入口；原子 batch、单 in_progress、rollover、branch 恢复及 ID 单调性均保留。
- **Question**：保留 rich TUI/RPC fallback、preview、自定义答案；取消、无 UI、加载失败各自表达。abort/reload 后 blocked 成对解除。
- **Consult（已确认纳入）**：改用 Pi 上游明确对扩展开放的 SDK 调用入口，核验目标 1.1 的公开 streamSimple/注册表路径后去掉不再需要的私有 runtime 探测；不改接模型厂商 HTTP API。保留原模型/账号/订阅渠道，以及 OAuth 凭据派生的 baseUrl、headers 等现有认证语义，不能仅凭能 import 就判定迁移完成；若公开入口不能等价表达，报告阻塞而非静默降级为付费 key 或删除认证兼容。watchdog 首期仅统计顶层，避免 nested+outer 双计；保留独立上下文、无工具、取消、预算、采纳/tree 状态。不实施仍待观察的 executor-context proposal。
- **Herdr**：进程控制 model-only，保留 pane/session/serverScope 所有权与 replay；BTW 是 CLI child，不能套 SDK 缺 factory 结论。原生 OSC 不能替代 session identity 与 custom UI blocked。子命令补全/空调用菜单改善已由用户暂缓，不在本轮实施。

## Contract / Test Impact

逻辑契约为“会话策略＋可信工具身份＋调用来源 → 允许/拒绝及原因”；active 状态不作为单独授权依据。

| 档位 / 输入 | 预期 |
|---|---|
| T2：codemode 未加载/未启用；仅 MCP direct | 普通工具、工作流及授权文档查询正常，配置不被擅自改写 |
| T1/T2：顶层与两层 nested 请求同一禁用工具 | 都拒绝，实际副作用零次 |
| T1/T2：MCP 晚注册、名称相似、资源无 server 参数 | 未授权连接/枚举/执行都不发生 |
| T1：工作流工具被脚本调用 | 明确不可调用，原顶层行为保留 |
| T1：两个 runtime/cwd，配置或 pins 不同 | 权限、默认值和状态互不污染 |
| T1：queued/handled/rejected、内部/外部 abort | 回执真实，无重复投递；清理不早于终态 |
| T1：合法 retain-none 与损坏 JSONL | 前者恢复，后者明确失败且不新建 |
| T0：子账本、父 rollup、重复 get/reload | 精确计一次，watermark 不回退或跳账 |
| 冻结 B10，仅参考：带 token 的命令、签名 URL | 后续目标是默认安全摘要；本轮不实施脱敏增强 |
| 冻结 B11，仅参考：upstream/fork 两种加载顺序 | 后续目标是冲突警告；本轮不新增该检测 |
| 冻结 B12，仅参考：schedule/RPC→archive→恢复 | 后续目标是补齐 chips；本轮不扩展或专项复核该链路 |
| T2：external 与真实安装 embedded | 权限与终态合同一致，失败不双跑 |
| T2：main Plan 的 planning/normal、MCP 接通前后 | planning 不扩权，审批/恢复行为不变 |

使用精确 1.1 SDK、离线 provider/MCP transport；禁止连接真实服务证明这些单元/集成合同。真实授权集成另设验收门槛。
