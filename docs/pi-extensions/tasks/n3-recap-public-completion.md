# N3：Recap 的公开物理模型完成路径

依赖E0。保留独立回顾、可选标题与现有取消/恢复行为，不把recap当compact，不引入虚拟模型、费用汇总框架或新multiplexer体验。

## Goal / Design

`extensions/recap.ts:runRecap`基线通过resolveCompleteModel优先调用ctx.modelRegistry.complete，传legacy compat的`context.systemPrompt`。后续真实SDK基线验证确认指令已被正规化保留，未复现丢失；本轮是显式native消息/公开类型适配及移除0.x兼容依赖，不宣传为修复已证实的丢指令缺陷。独立合同仍验证实际system指令、语言/JSON规则与路由/取消行为，基线绿色合法，不人为制造红测。

- 使用1.1公开物理模型完成接口和native Context；保留选定provider/model、订阅/OAuth/API-key路由、sessionId/maxTokens/signal及既有OpenCode会话headers。不把固定模型换成当前模型或同名的另一付费渠道。
- 请求builder、类型和已有unit注入点相应适配；目标仅1.1+，不需保留0.x私有/compat兜底。注入completeModel可作为已有unit seam保留，但真实SDK合同不能靠注入函数自证。
- model='current'、显式provider/model、缺失时fallbackToCurrentModel true/false的既有行为保留。未选虚拟模型能力不扩展；不为此新建路由/拒绝框架。
- 自动/手动取消、旧完成被忽略、标题applyPolicy、已有recap entry/source水位和reload行为不回归；不重写整个1400行入口。必要小的职责拆分可以，不为行数机械拆分。
- 旁路请求可能产生费用。公开registry调用不等于宿主agent loop自动累计；双语说明保留此边界，不伪造usage/session_summary或修改Meter/账单数值。

## 独立合同 / Test Impact

预留`packages/pi-recap/tests/pi11-completion.contract.test.ts`（node:test/tsx）。作者不读产品体/实施者测试。

T1：实际选定模型收到system指令及最近会话文本，保留300 maxTokens、会话身份/适用headers和取消signal；JSON回顾结果正常入自定义entry，title off/允许应用分别正确。显式模型不存在时false不调用、true只按现有规则fallback并告知；不是任意替换渠道。

T1：手动signal abort及自动input/agent_start/shutdown取消后，迟到完成不得追加回顾或覆盖标题/widget。无新活动不发请求。既有title恢复/去重规则不改。

T2：真实SDK注册、public modelRegistry.complete与离线faux/native provider，验证native messages而非只看注入spy。普通TUI/sidebar行为用合成UI，不冒充真实终端。

公开入口：default extension来自`extensions/recap.ts`；导出`DEFAULT_CONFIG:RecapConfig`、`createRecapState(config?):RecapState`、`resolveRecapModel(ctx,config)`、`runRecap(pi,ctx,config,state,reason:'manual'|'auto',options?:{force?,signal?,showProgress?,completeModel?}):Promise<RecapEntryData|undefined>`。RecapConfig包含recap{auto,idleAfterTurnMs,model,fallbackToCurrentModel,language}、title{applyPolicy:'off'|'if-empty'|'if-empty-or-auto'|'always'}、multiplexer{enabled,template}。精确类型用type-only/Parameters获取，不读实现。

真实fixture用临时agentDir配置`extension-data/pi-recap/config.json`，必须auto:false、multiplexer.enabled:false，避免真实pane改名/命令。SDK公开`session.bindExtensions({mode:'tui',uiContext,...})`，可在真实factory事件回调捕获原pi/ctx；不要手造整个modelRegistry。传输与multiplexer外部命令边界必须离线隔离，未知网络/外部命令失败；不接触用户Herdr/tmux/账号。公共完整签名缺口按符号报告，不弹审批问卷、不读实施体。

## 交付边界

仅本包必要源/自有tests/双语README/包级docs/单独changeset。完整check/types、真实SDK物理模型合同和loader/pack；独立作者提交baseline pass/red/fixture。实现者不读改预留文件，不改其它包/依赖锁/真实配置。所有验证targetPATH/run-isolated，无真实模型/额度调用；后续必要live优先Cursor grok-4.7但须先交具体方案。允许本地commit，禁止push/main/release。
