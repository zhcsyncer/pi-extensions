# R2：会话级工具授权边界

依赖 R1 已验收；进度只在执行编排 §0 更新。先交接接口/权限映射，再经协调者确认实施，不把未知权限语义交给实现者自行扩展。

## Goal / AC

普通 child 的直接调用继续可用；隔离、只读与显式工具子集不能被 nested、晚注册或恢复绕过。把授权保存在已有 runtime/manager 语义中，active/visible 工具只是模型视图。

1. 使用 child inline extension 的公开 `tool_call` 检查作为实际执行门槛，覆盖首轮、后续轮、顶层和至少两层 nested；不只替换 `session.agent.beforeToolCall`，不把 active 集合误作授权。
2. 保留 builtin 精确集合、disallowedTools、extSelectors 的扩展来源/工具子集含义。授权工具可晚注册后正常使用；未授权晚注册或名称相似的工具不能借同名进入。基于实际加载来源识别，不修改 getAllTools 的元数据副本。
3. pins 只保观察者加载，不授予工具/连接。isolated/reviewer 仍无 codemode/MCP；format-repair 仍空工具。实际 MCP 连接/factory/资源控制留 R3，R2 不以“以后有 gate”为由提前开启。
4. 仅对影响权限/运行决策的配置消除现有跨 runtime/cwd 串用；两套配置及 pins 必须相互独立，不新造通用上下文框架，不修冻结的 Search 跨会话配置问题。
5. recipe 记录策略版本和必要的非秘密身份；恢复授权不得超出“历史上限 ∩ 当前有效授权”。撤销权限后恢复不能获得旧能力，旧格式缺信息不能静默推断更大授权；明确旧 recipe 迁移/拒绝策略并先交接。
6. Subagents 自己的 Agent/get/steer 实际 ToolDefinition 设置 model-only；保留顶层直接调用、sequential、终态、恢复和费用合同。不得为此改变 failed/aborted/stopped 必须显式 resume 的规则。

## 已定位的设计边界

- `packages/pi-subagents/src/agent-runner.ts:installExtensionToolScope` 当前从实际 loader extension.tools 计算 extSelectors/pinnedOnly 范围，turn_end 调整 active tools，最后替换 agent.beforeToolCall；迁移执行门槛但保留合理的模型视图收窄。
- 同文件 createSessionForAgent 附近，noExtensions 使用静态 tools，其他路径用 excludeTools 配合动态范围；已有 pinned/runtime 和 snapshot/restore 分支应复用，不能靠只冻结初始注册名让合法晚注册永久丢失。
- `src/index.ts` 是本包工作流注册入口，`agent-manager.ts` / `types.ts` 承载 runtime、恢复配置与回调。R1 的 usage 累计快照、结算屏障、generation fence 是已验收前置，不重写。
- 相关总体意图在 `docs/pi-subagents/pi-1.1-runtime-plan.md`。此阶段不实现 R3 factory/MCP 的传输层，也不把 MCP 名称前缀当后续授权依据；要给 R3 留清晰的策略扩展边界。

## 第一阶段（只读交接）

1. 按精确 SDK1.1 的公开类型/运行证据列出 tool_call 顶层与 nested 的可观察身份和拒绝效果；证明 hook 的装配时点不会被 SDK 再次覆盖。指出现有 caller/runtime 配置真正串用的位置，不泛化清理。
2. 给出最小策略形状、配置来源、晚注册判断、恢复交集/旧 recipe 处理及 R3 可接入位置。区分已有明确授权的行为和需要用户/协调者决策的缺口；不得自行把普通 child 全部开 codemode/MCP，也不得无声关闭既有直接工具。
3. 固定独立作者所需的公开运行入口、合成角色/扩展 fixture、两个 runtime 与恢复场景；不暴露私有测试接参 API。回答后停下，由协调者冻结接口后再实施。

## Contract / Test Impact

T1 权限状态机、T2 真 SDK 执行链。独立测试保留路径 `packages/pi-subagents/test/pi11-permissions.contract.test.ts`（Vitest test/**/*.test.ts），实现者不得写；可维护既有测试。

| 输入 | 必须观察到的行为 |
|---|---|
| 同一未授权写工具，顶层/一层/两层 nested | 全部拒绝，实际文件/计数副作用零；工具应确实已注册，不能用“工具不存在”假证授权 gate |
| 对应授权工具，同样三种入口 | 正常执行，结果保真；不能用 blanket deny 达成负例 |
| 首轮或 turn 间晚注册授权扩展工具 | 按声明范围可用；不受初始名字快照误伤 |
| 未授权来源、工具子集外成员、同名/相似名来源 | 不执行；仅 active/visible 的变化不能扩权 |
| pinned-only 观察者 | 监听行为允许，但它的工具零执行；无 MCP 工厂/连接授予 |
| 两个 runtime/cwd 配置与 pins 不同并交错操作 | 各自权限稳定，不能后创建者覆盖先创建者 |
| 权限撤销或收窄后恢复；旧版本 recipe | 不恢复超出交集的权限；迁移/明确失败不新建会话冒充恢复 |
| nested Agent/get/steer | 宿主 model-only 门槛拒绝，实际 manager 操作零；顶层原行为仍通过 |
| R1 已验收回归 | 生命周期16例、费用水位、源码与测试类型检查持续通过 |

## 第二阶段允许范围与交付

仅协调者解锁后写 Subagents 相关实现/既有测试、必要双语/包级文档和独立 changeset；不改依赖锁、统一进度、其他包或全局真实设置。B10/B11/B12、Plan relay 及其他冻结目标不实施；同文件内必要 API/类型调整不能借机完成冻结功能。

沿用用户“仅支持1.1+”与隔离环境：指定 PATH、scripts/run-isolated.mjs、真实 SDK＋离线 provider/合成扩展，禁止真实模型/MCP/账号请求。读取全局 coding/仓库/Herdr/worktree 规则及相关 SDK 文档完整链接。交付本地 commit 和精确测试边界，不 push/main/release，不自行再派实施者。
