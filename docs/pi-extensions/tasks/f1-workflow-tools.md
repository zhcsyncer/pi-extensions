# F1：Todo 与问答的 Pi 1.1 调用入口

依赖E0已通过。只做已批准的工具入口适配及必要SDK兼容，不重构工作流或新增安全框架。

## 当前逐包决定（2026-10-19）

用户已分别确认Todo与Question保留model-only。Todo暂无必要脚本使用场景，不为此扩展持久化/恢复；Question选择由模型直接发起问答，不另做脚本弹问卷。Question属于明确的交互入口策略，不套用Todo的数据恢复实测问题，也不声称SDK通用要求或修复已证实的嵌套问答故障。原TUI/RPC、预览、多选/自定义回答、取消和加载失败行为保持。

保留限制有当前实现依据，而非SDK通用要求：任务变更的恢复信息放在直接Todo工具结果里，嵌套路径没有相同的持久恢复保证。实际SDK1.3六组离线探针中，仅撤限制的候选副本经codemode创建成功、live列表可见，但reload后丢任务并复用ID；其它工具原样转交结果也不能恢复。直接调用正控可正常恢复并递增ID，当前限制拒绝嵌套且不改状态。证据见 `/var/tmp/pi-todo-review/REPORT.md`；不是未改旧包整体测试，tree/compact仅静态核对。model-only同时限制查询，不是人工审批，也不自动禁止子代理在自己会话内直接调用。

## Goal / AC

Todo和问答继续由模型直接调用；不能被脚本/其他工具嵌套触发任务修改或弹出表单。使用宿主现成model-only，不自己再造一套调用授权。

- 在真实注册定义设置`exposure:"model-only"`：Todo入口`packages/pi-todo/index.ts`→`todo.ts:registerTodoTool`；问答入口`packages/pi-ask-user-question/index.ts`→`ask-user-question.ts:registerAskUserQuestionTool`。
- 保留原有执行模式、参数/返回、命令、状态与交互。当前定义没有executionMode，不添加新的sequential要求；model-only与调度不是一回事。
- Todo保持原子batch、单in_progress、rollover、分支恢复、ID单调和checkpoint格式；不借升级改任务规则/存储。
- 问答保持TUI/RPC、preview、自定义回答；取消、无UI、加载失败分别表达。现有blocked/unblocked在abort/reload后仍配对，不让失败遗留等待状态。
- 普通模式不需要codemode；native ctx.executeTool的嵌套负例应零状态修改/零表单，不只断言字段字符串。宿主在nested callable集合排除model-only属于合法拒绝，不要求命中工具函数。
- 如发现确实影响1.1工作的差异，最小修正并说明复现；不做命令体验、额外防御、无关清理或其他包改造。

## Test Impact

既有包级check/typecheck与真实1.1 loader保持通过。增加少量真实SDK集成回归，使用空配置/离线provider：

| 场景 | 行为 |
|---|---|
| 顶层Todo合法batch创建至少2项，然后查询 | 真实状态变化、结果正常；非法原子batch仍整体不生效 |
| 同样参数从实际嵌套工具调用Todo | 拒绝，任务状态及持久checkpoint不变 |
| 顶层问答、受控公共UI输入/既有RPC路径 | 返回合法选择/自定义回答，保留preview能力 |
| 实际嵌套调用问答 | 拒绝，公共UI/blocked入口未开启 |
| 问答abort/reload、无UI/加载失败 | 不残留blocked；保持原有清晰失败/取消结果 |
| tree/reload/新session、普通直接调用 | 原Todo与问答行为不因model-only字段改变 |

不复制整套既有UI测试，不测DOM结构或纯参数透传。纯metadata添加本身不要求新通用测试接口；给组合审阅提供真实loader/调用侧证据，测试缺口如实报告。

## 范围与执行

允许上述两包相关源码、必要测试/双语说明、独立changeset；每包说明自己的用户可见变化，根包可同列。SDK/lock已就绪，不修改manifest/lock、其他包、全局设置或进度表。只支持Pi1.1+，不增加旧版本兼容层。

读取全局coding规则、仓库/Herdr/worktree规则、testing方法论及相关SDK文档完整链接。使用指定PATH及run-isolated，不调用真实问卷交互打断用户或改真实任务数据。离线回归优先；若确需真模型测试，按用户要求优先cursor/grok-4.7，先说明必要性与隔离方案，不改账号配置或换其他付费渠道。

用户已授权实施；先确认cwd/origin/base，给出将改的实际注册点与测试入口后实施。可本地提交，不push/main/release、不派其他实施者。交付固定commit、完整检查和实测边界；独立组合审阅通过后由唯一调度者集成。
