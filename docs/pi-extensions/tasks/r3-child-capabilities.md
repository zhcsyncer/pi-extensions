# R3：按已有选择给子会话装配原生能力

依赖R2/K1已验收。普通工具仍是主路径；仅用户/会话已启用且角色允许时装配codemode/MCP，不能为升级自动开启。

## Goal / AC

- 复用精确SDK1.1公开factory；codemode与MCP direct独立，默认不加tool-search factory。isolated/reviewer不装配，format-repair保持空工具；pins只保观察，不授予工具/连接。
- 沿用现有runtime配置与R2 gate，不再造平行授权/上下文框架。配置server和扩展后注册server均须在连接、枚举、执行前按实际配置允许范围过滤。
- MCP共享loader owner不足以区分server；用真实配置/profile/连接来源及实际注册名和schema识别，不因mcp前缀、同名、builtin:mcp或readOnlyHint自动授权。
- 原生Context7精确身份沿用K1 `docs/pi-context7/native-mcp-migration.md`；旧REST入口仍可用，不修改用户真实profile，不把子会话能力静默缩减为关闭MCP或强制旧REST。
- 首期无资源需求，拒绝三个MCP资源工具；不为它们新造资源权限产品。不改变RPC/tool调用参数或model/account语义，不进入Plan relay、B10–B12。
- 已持有的当前能力与恢复上限一致；不在recipe存URL密钥/header等秘密。仅补实际需要的非秘密身份，不为理论攻击设计新协议。

## 第一阶段：只读公共装配交接

先读完整runtime计划及K1身份合同，暂不编辑/提交：

1. 公共factory、当前settings/profile启用选择、role选择如何衔接；列真实参数/生命周期，不凭作者本地配置推默认。
2. 用离线内存MCP transport验证连接前筛选、晚注册、真实ToolInfo及server/tool/schema对应事实；确定R2现有gate的最小接入点。拿不到必要身份时说明具体API缺口，不发明通用证明库。
3. 给独立作者稳定公开fixture入口，证明普通direct、仅MCP、仅codemode、两者组合和禁用/isolated/pins路径；恢复与多runtime不串。已有公开接口可复用就不新加测试接参。

只交最小改动方案、实际SDK证据及未决选择后停止；调度冻结再实施。禁止真实Context7/MCP、账号/配置切换。即便需要模型生成也先faux；用户的Cursor/grok-4.7偏好不自动授权MCP服务。

独立测试预留`packages/pi-subagents/test/pi11-capabilities.contract.test.ts`。未来仅本包必要实现/既有测试/双语说明/changeset，其他包消费者留后继；不改SDK/lock、预留独立测试或统一进度，不push/main/release。绝对coding/Herdr/worktree/testing与SDK文档读取规则沿用。
