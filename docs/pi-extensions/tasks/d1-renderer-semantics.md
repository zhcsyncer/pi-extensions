# D1：公共工具 renderer 与执行语义保真

状态：派发前合同；依赖 E0 已验收集成。本任务不实现缓存、nested 聚合或消息导航，分别留 D2–D4。

## Goal / AC

以 Pi 1.1 的公开 renderer 注册能力接管显示，而不是通过修改工具元数据假装改动真实定义；同时保留 Bash 意图、Write 执行前捕获等真实执行装饰，不让统一样式改变工具行为。

1. built-in、custom、晚注册 MCP 与只存在于历史中的工具，按宿主 resolver 选择 renderer；与原 renderer 的组合显式委托，不拦截本扩展 registerTool 来冒充能看到其他扩展注册。
2. 必要语义包装保留真实原定义及第五参数执行 context，不丢 `outputSchema`、采样/prepare/exposure/loadout 等原有能力；检查真实注册结果，而不是修改 `getAllTools()` 返回的副本。
3. 仓内只对 Bash 自动添加 displaySummary；直接或 codemode 脚本缺该字段时现有 prepare fallback 生效。其他非法参数仍拒绝，展示字段不传到底层。codemode raw-JS grammar/schema 不变，不向其他工具批量添加字段。
4. 结构化成功、非零退出、取消以及 context 相关行为保真；Write 的执行前原内容捕获语义继续有效。只显示优化，不静默放宽权限/启用 codemode。
5. 完整处理 renderer context：原始参数、duration/showImages/outputPad、state/lastComponent 等；包装器自己的状态与委托 renderer 的状态不串用。self shell 主动处理留白，default shell 不再重复补。
6. codemode 未加载/未启用时普通展示仍正常；历史展示不重执行工具、不为了打开历史自动启用 runtime。

## Design / 写入边界

主要入口是 `packages/pi-tool-display-intent/src/tool-overrides.ts` 的 registerRuntimeTool/createBuiltinToolBase/registerToolDisplayOverrides，以及 `src/index.ts` 接线、`display-summary.js` 已有 helper、相关 renderer/shell 组件和测试。现有 helper 已能补位并传 context；已确认外围 createBuiltinToolBase 只传四参且手工挑字段，修复应针对真实丢失边界，不为 displaySummary 再造机制。

使用目标 1.1 公开注册 API，将显示 ownership 与执行语义装饰分开；保留没有公共替代的 aggregate/消息补丁，不在 D1 顺手完成 D2–D4。保持合作工具专用内容与历史兼容，不建立通用跨扩展注册代理。HTML exporter 会分别 resolve call/result，共享 state 不能依赖同一个组合器实例或 lastComponent 恰好存在；必须按宿主调用状态与注册 owner 保持隔离。事件回调晚于工厂初始化创建的 aggregate 定时器也须绑定所属 session/projection，不能只清理 render 回调作用域，更不能全局清理别人的新 owner。必要代码整理围绕本次变更边界，不以大文件行数为理由扩展重构。

只写 Tool Display 包的实现、测试、双语说明与独立 changeset；SDK/manifest/lock 归 E0。不得改其他包、真实 Pi 设置、用户 defaultTools/mode，也不直接合入 #149/#150。

## Contract / Test Impact

T1 为意图预处理、ownership、状态隔离；T2 为真实 1.1 loader/registry 与执行路径。纯样式不堆 DOM/字符串快照测试。

| 场景 | 可观察结果 |
|---|---|
| 真实 Bash 直接/nested 缺 displaySummary，提供合法 command | prepare 补位，命令按原语义执行；底层不收到显示字段 |
| 其他非法参数/原 prepare 拒绝 | 不被 fallback 隐藏，仍明确失败 |
| Bash 结构化成功、非零退出、取消，合成 context 含模型身份 | 保留原结构/错误/取消行为与 context，不丢采样/输出 schema 能力 |
| 原生 codemode 注册并执行 raw JavaScript | grammar/schema 保持原契约，不强加 JSON 意图字段 |
| 自定义专用 renderer 与统一外壳组合 | 专用内容保留；原/包装 state 与 lastComponent 各自正确，padding 不重复 |
| 不同加载顺序、MCP 晚注册、只含历史的旧工具 | 正确 resolve/委托，不重复注册执行工具，不改变工具可用权限 |
| reload、旧 session 清理与新 owner 并存 | 只撤销自己仍持有的装饰，不拆掉后来注册的其他 renderer |
| session.exportToHtml 分别解析 call/result | 原 renderer 在 call 写入的 state 在 result 仍可见；不能只验证缓存的同一组合器 |
| aggregate 事件创建活动定时器，随后 shutdown/reload | 已创建的旧 timer 停止；旧 owner 清理不关闭新 session 的活跃 timer |
| codemode 未加载/未启用，打开旧脚本历史 | 普通工具仍可用，无自动启用或重执行 |

优先使用 E0 建立的目标 SDK 与隔离 agentDir，MCP 用离线 transport；不能用可变 ToolInfo stub 证明真实注册正确。E0 已交接目标 1.1 的公开 `DefaultResourceLoader`、`ExtensionRunner` 与 `ExtensionAPI.registerToolRenderer`；注册接线见任务 `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:289–292`，resolver 类型见 `extensions/types.d.ts:513`，解析见 `extensions/runner.js:542–546`，按扩展加载顺序委托 next 最终落到 base。HTML 测试入口为 getToolRenderers，旧 callback 的夹具适配已由 E0 完成，不再作为本任务生产 bug。独立测试编写前，D1 在写实现前确定原 renderer、晚注册离线 MCP、历史独有工具的最小 fixture，以及重绘/reload 的触发和结果观察方式，由调度者固定给测试作者，不让其靠新实现猜测试接线。

Write 的可观察合同是：对预先存在的内容 A 执行写入 B 后，展示仍以调用发生前的 A 为旧内容，而不是用写后的 B 或后续修改 C 冒充旧内容；新建文件不伪造旧正文。测试应观察执行后的真实结果/公开显示产物，不只断言内部 read 被调用；具体输出出口由 D1 的接口交接提供，保持现有用户体验，不为测试新增产品 API。

高风险合同用例由独立测试作者按合同编写，冻结交付后在候选树组合实现验收。实际 Mac 全屏/输入性能留 D2/D4 与 L1，不冒称 D1 已全端验收。

## 已冻结的实现/独立测试交接

独立测试作者独占 `packages/pi-tool-display-intent/tests/pi11-renderer.contract.test.ts`；只按合同/SDK 公共文档和测试基础设施写用例，不读产品实现。实现者不改此文件，可维护其他现有测试。首次完整只读交接证据在 `/tmp/pi11-display-phase-one-handoff.md`，以下保留独立写测试必需的入口。

- 真实产品入口：本包 `extensions/tool-display-intent.ts`。使用 SDK 根导出的 `DefaultResourceLoader`、`SettingsManager`、`ModelRuntime`、`SessionManager`、`createAgentSession`。loader 传隔离 cwd/agentDir、in-memory settings、按加载顺序排列的 additionalExtensionPaths/extensionFactories，关闭 skills/themes/promptTemplates/contextFiles 自动发现；reload 后 errors 必须为空。ModelRuntime 关闭模型网络和初始化刷新，auth/models/cache 均在空 agentDir；session 绑定 onError 回调。
- resolver 公开签名为 `(toolName, next: () => ToolRenderers | undefined) => ToolRenderers | undefined`。通过 `session.extensionRunner.resolveToolRenderers(name, () => session.getToolDefinition(name))` 解析；后者才包含 built-in，不能只查 runner 的扩展定义。next 最终进入 base，不自动合并字段。
- 隔离配置文件用 v2 的 toolCalls.layout=individual、results.mode=preview；自定义 probe 设置 tools.custom.probe={renderer:generic,mode:preview}，避免默认隐藏结果干扰合同。原 renderer fixture 在真实 extension 中 registerTool，带原 schema/prepare/execute/renderers，输出可辨认 Text/Component；比较显示/执行行为，不检查包装器私有字段。
- 动态注册先用真实 ExtensionAPI；MCP 场景另以原生 `createMcpExtension({loadConfig,createTransport})` 和本地 transport 完成 initialize/tools/list/tools/call。工具列表返回前后以 gate 控制，观察真实 `mcp__offline__probe` 的定义/renderer，不能用手工同名注册冒充 MCP 握手。历史独有工具不注册，base 返回 undefined，以保存 args/result 创建行；执行次数和 active tools 必须不变。
- 公共 `ToolExecutionComponent(name,id,args,{showImages:false,outputPad:0},resolve(name),tui,cwd)` 配合真实 TUI 与已有 AggregateTerminal。通过 updateArgs/setArgsComplete/markExecutionStarted/updateResult/setExpanded/setOutputPad/setShowImages/invalidate/render 驱动，不直接调用私有布局。renderCall(args,theme,context)、renderResult(result,{expanded,isPartial},theme,context)；call/result 共享 state，但 lastComponent 分槽，委托 renderer 看到自身组件而非外壳。
- 用 `session.reload()` 后的新 runner/resolver 重建行，旧 owner 清理通过两套真实 loader/session 验证，不篡改注册表伪造。未持久的 Write 原内容不要求通过 reload 重建，不凭当前文件冒充历史。
- 执行测试用离线 streamFunction 返回工具调用/停止响应，再 `session.prompt()`，经过真实 prepare/validation/execute。Bash 用合成模型身份与 PI_SESSION_ID/PI_PROVIDER/PI_MODEL/PI_REASONING_LEVEL 输出观测 context，并与原生 `createBashToolDefinition(cwd)` 对照成功/非零退出/取消。直接调用 execute 只能作补充，不能替代执行链路验收。原生 codemode factory 的执行参数为 {code}，不改变 raw-JS grammar。
- Write 的公开观察出口是同一次调用行的展开 diff：预写 A → 实际写 B → 外部写 C → 对原调用 ID updateResult/展开/render，保持 A→B，不出现 C；新文件不伪造旧正文。

若 SDK 实际类型与上述交接不一致，测试作者向调度者报告具体差异，再核对公开定义；不阅读新实现来修改期望，也不为了通过测试要求新增产品测试 API。

## 派发与交付

完整读取全局规则绝对路径 `/root/.agent-vm-state/pi/agent/AGENTS.md`、`/root/.agent-vm-state/pi/agent/rules/coding.md`、`/root/develop/AGENTS.md`、worktree AGENTS.md，以及 Tool Display 规格、目标 SDK extensions/TUI 及相关文档。先回报 cwd/origin/base/允许写范围。

交付本地任务 commit、行为测试结果、D2 接入点/仍保留补丁的理由，不 push/main merge/release，不改全局进度。遇公开 API 不足以实现已选合同，报告具体缺口，不改用未经批准的新架构或伪造通过。
