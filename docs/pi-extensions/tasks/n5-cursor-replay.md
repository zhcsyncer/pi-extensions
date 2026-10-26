# N5：Cursor 的 Pi 1.1 有效上下文重放

> **当前决定（2026-10-20）**：用户选择“只回撤本轮改造”。Cursor整个包恢复到f48a91b基线，本轮新增独立合同撤销、退出本轮适配和单独发版候选；不宣布停止维护、不新增停维护README、不删除包或历史加载入口、不改变本机安装/模型/认证。以下为已撤回方案的历史证据，不能再作为本轮实施要求；既有测试成功或已知缺陷不授权继续修改Cursor。

依赖E0，现有基线已具备精确1.1 SDK。完整范围见`docs/pi-provider-cursor-ask/pi-1.1-adaptation-plan.md`。只做已批准的重放/必要兼容，B02标准usage、B04额度旧债及虚拟模型不做。

## Goal / Design

Cursor请求与上下文锚点都应看到Pi当前生效的系统提示/工具，而不是所有历史配置的拼接。

- 已定位`src/stream/context-usage.ts`的replayedSystemPrompt自行追加所有system sections，不能正确替换同名section或删除null；replayedTools也维护独立重放逻辑。
- 两者改为复用目标SDK1.1公开`getCurrentSystemPrompt`/`getCurrentTools`语义。`src/stream/pi-adapter.ts:contextToCursorChatCompletionRequest`与context tracker已共同调用这两个exports，保留这个共享点，不重造两套算法。
- 保留已有上下文锚点及scope/history有效性规则、估算、overflow guard、Cursor Connect/protobuf/Run生命周期、认证与订阅路由、取消/重试。不借重放修复改usage数值语义或quota producer协议。
- `context-normalize.ts`、client-transcript等只在确有必要的1.1回归下最小修改，不全盘重构。

## Contract / Test Impact

| 场景 | 预期 |
|---|---|
| 同名system section替换/null删除，content追加 | 真实构造请求只有当前有效sections，content保持SDK规定的追加语义 |
| 工具移除、同名重定义及空列表 | 请求tools与SDK当前状态一致，无旧schema残留 |
| 等效当前system/tools经不同历史更新得到 | 其它scope输入和非system历史相同且当前有效配置相同时，scope一致；旧的已失效sections/schema不进入当前估算或请求 |
| 当前配置真实变化、压缩/换model/session/history | 既有锚点正确失效；不把累计billing当上下文fallback |
| native流、取消、重试、options及录制协议fixtures | 现有渠道和事件/终态无回归，不做B02新回执研究 |

独立测试预留`providers/pi-provider-cursor-ask/tests/pi11-replay.contract.test.ts`（Vitest）。作者只看合同、公开声明/SDK文档/通用infra，不读待测实现或实现者测试；类型可以type-only导入或Parameters/ReturnType取得。

## 独立测试公开入口

- `src/stream/context-usage.ts`导出`replayedSystemPrompt(context:Context):string`、`replayedTools(context:Context):NonNullable<Context["tools"]>`、`createCursorContextTracker(model:Model<Api>,context?:Context,options?:{sessionId?:string;reasoning?:string})`。
- tracker公开方法：`begin(mode:"history"|"checkpoint"|"live",inheritedTokens?:number,checkpoint?:Uint8Array):void`；`observe(tokens:number,output:AssistantMessage,checkpoint?:Uint8Array):void`；`finish(output:CursorAssistantMessage):{tokens:number;source:"checkpoint"|"estimate";scope:string;history:string}`。finish按既有合同写入output.cursorUsage。scope/history按opaque值比较行为，不断言具体hash算法/私有字段。
- `src/stream/pi-adapter.ts`导出`contextToCursorChatCompletionRequest(model,context,options,config)`。参数类型`CursorNativeStreamOptions`、`CursorNativeStreamConfig`从`src/stream/types.ts`导出；config唯一必填是`getAccessToken:(options?:{forceRefresh?:boolean})=>Promise<string>`，请求构造测试应提供抛错的控制函数证明不进入认证，不用真实token。其余routing/noReasoning getter可选，普通fixture可省略。
- 第一个目标是实际请求messages/tools与tracker一致；不只测wrapper等于SDK或mock返回值。公开SDKSystemMessage/Tool声明定义输入，覆盖真实替换/删除行为。

## 范围与验证

仅本provider必要源码/既有测试/双语说明/包级文档/独立changeset；不改manifest/lock、生成proto、其它包、真实auth/config或总进度。保留cursor-include/cursor-other来源与当前账号/订阅，不改接通用OpenAI/XAI endpoint。

实现者给原缺陷失败证据，跑完整package check（含类型/lint/format/security/proto/tests/legacy/build）及真实loader。基线已红需明确区分，不把修改格式/测试期望当消除行为缺陷。独立预留文件不可读写。

离线回归用指定PATH/run-isolated，禁付费网络调用。确需之后真模型烟测时，按用户要求优先现有Cursor provider的grok-4.7，只发合成最小上下文；先交可用模型/既有认证路径/隔离方式，不打印或复制凭据、不改登录、不擅自换渠道。这里不自动授权真实quota请求或修改用户profile。

读取绝对coding/Herdr/worktree/testing规则、相关SDK公开文档完整链接。本地提交允许，不push/main/release、不再派实施者；独立审阅与集成态复验后才算交付。
