# P1：Plan 工作流与 Context7 精确授权

依赖R2/K1。保留既有审批/恢复流程、旧REST正常使用；submit_plan/complete_plan按SDK model-only限制由外层模型使用。不合并/启用relay，不另造权限系统。

## 已批准行为

- 真实注册的submit_plan/complete_plan声明model-only，native nested不得触发审批UI、状态更新或持久化；ordinary直接工作流仍可用，不加sequential。
- planning执行边界是实际tool_call授权，不是只隐藏active tools；审批/拒绝/取消/reload/tree恢复不额外扩权，普通工具集合正确恢复。
- 保留旧Context7 REST精确授权；已核验native Context7仅resolve/query两项可用，不放行任意MCP前缀或其他资源工具。
- 身份必须满足`docs/pi-context7/native-mcp-migration.md` K1合同：可信profile/session、有效连接配置及来源、server/认证拥有者、原始工具名、实际注册名/schema。builtin:mcp或getMcpServers单独不够，未知/晚到/变化的未核验声明不放行。

## 当前只授权第一阶段：短只读接线核验

已定位extensions/plan-mode.ts的registerTools（submit/complete）和restoreState、src/policy.ts名称允许表、src/lifecycle.ts；当前只读表保留旧REST名称，无native MCP可信绑定。

请回答一个具体问题：在精确1.1公开API和现有profile/session数据下，能否给父会话Plan提供K1要求的可靠、当前的Context7绑定，而不复制SDK loader/auth、不反猜hash名字、不新增凭据迁移/证明框架？

- 复用已存K1/R3离线证据及公开声明；R3子会话连接前过滤已因不同缺口暂停，不据此预判父Plan一定同样阻塞，也不放宽原合同。
- 最多补一两项必要离线探针：真实native注册及身份/来源可观察点，允许/相同名字或schema但不同来源的拒绝正负控。合成transport，不访问真实MCP/profile。
- 同时列出原工作流和model-only的最小改点、真实SDK独立fixture接口；不编辑生产/测试、不提交代码。
- 输出已确认事实、最小接线或明确缺少的公共数据，随后停止；不为所有边界穷尽证明继续扩读SDK。不能做到就报告，不静默交付仅旧REST并标整个P1完成。

## 第一阶段结论与第二阶段冻结：仅P1-A工作流

公开ToolInfo可给注册名/schema/namespace/sourceInfo，但无当前有效连接来源、认证拥有者与原始MCP工具的可信绑定。getMcpServers/mcp_servers_change不是合并文件配置与认证变化视图；工厂hooks替换默认实现而非观察默认实现。父Plan执行拦截可用，缺口不同于R3的连接前限制；没有新增探针，复用K1/R3实际证据。native Context7子范围P1-B暂停，未知native工具继续拒绝，整个P1不因P1-A通过而完成。

P1-A现在授权实施与独立测试：
- 生产改动原则上仅两个registerTool增加exposure:model-only。已有executionMode:sequential保留，不借本轮改调度；不修改policy/lifecycle以假装支持native身份。
- 保持实际direct调用能提交完整plan、运行隔离revdiff、显式批准后完成精确revision；拒绝/取消不产生implementing或完成状态。
- nested必须由SDK真实调用链拒绝，在审批UI/文件/状态副作用前；不能用工具不活跃或整个execute_script被Plan拒绝的假阳性证明model-only。要有相同流程的直接成功及nested载体实际可执行正控。
- ordinary旧REST/只读工具、tool_call最终拦截、mode切换与reload/tree恢复不新增扩权；仍不注册任何nativeMCP允许项。
- 允许必要自有回归、双语用法说明和独立changeset；不宣称P1-B完成。发现超出两处metadata的真实缺陷先报告，不拓展状态机或证明框架。

本阶段独立预留`packages/pi-plan-mode/tests/pi11-workflow.contract.test.ts`，实施者不得读写。后续P1-B仍预留`tests/pi11-authorization.contract.test.ts`，当前不实施。独立基线允许metadata缺失/真实nested副作用红，但fixture缺口单列；固定组合审阅与集成复验只验收P1-A子范围。

仍禁push/main/release、升级SDK/宿主、改账号或真实MCP连接。
