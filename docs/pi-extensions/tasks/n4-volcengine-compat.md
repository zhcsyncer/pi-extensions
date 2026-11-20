# N4：Volcengine Agent Plan 的 Pi 1.1 兼容

依赖E0。保留专用Agent Plan订阅渠道，不因模型同名切到普通方舟/Moonshot/OpenAI API-key端点。不更新模型价格/目录或开发额度自动刷新/虚拟模型。

## Goal / Design

现有`index.ts`由createAgentPlanProvider创建native provider，注册openAIResponsesApi及openAICompletionsApi。核对并显式关联正确的公开`OpenAIResponsesCompat`/`OpenAICompletionsCompat`类型；CatalogEntry目前Model<ArkApi联合>会弱化api与compat关联，可最小类型收窄，不引入新运行时provider框架。

实际目标是确认1.1注册、tier/thinking/headers/认证/流错误与取消正确。如果现有运行行为已正确，保留它，只补必要类型及真实SDK回归；不要为了任务必须改出新行为。

## Contract / Test Impact

预留`providers/pi-provider-volcengine-agent-plan/test/pi11-provider.contract.test.ts`（node:test/tsx），与实施者测试隔离。

- 所有模型仍属于`volcengine-agent-plan`，base URL保持`https://ark.cn-beijing.volces.com/api/plan/v3`；`kimi-k2.7-code`走chat/completions，其余现有响应模型走responses，不混用compat选项。
- tier small不开放minimum medium的kimi-k3；medium/large/max按当前目录规则。已存credential tier优先于环境、缺失时沿用既有medium默认，不读取真实环境账号。
- 存储Agent Plan凭据与两个专用环境key的既有优先顺序不变；实际请求headers用该渠道凭据，不携带另一个provider key。auth check/resolve不得顺便进行模型推理或登录。
- deepseek-v4.1-flash和doubao-seed-2.1-turbo的thinking off/非off分别传disabled/enabled；保留原reasoning/include，不改变其他provider请求。chat Kimi的reasoning-content回放等compat能力按1.1实际adapter验证，不只断言常量字段存在。
- 真实adapter的成功流、取消、服务端错误保持SDK语义；失败不变成功，不跨渠道自动重试。不发真实login验证、账户或额度请求。
- 参考API cost仍不是Agent Plan账单；无目录/价格更新，README不承诺真实在线验收。

## 独立公开入口及fixture

`index.ts` default extension调用`pi.registerProvider(createAgentPlanProvider())`并注册before_provider_request hook；导出`createAgentPlanProvider(options?:{fetchImpl?:typeof fetch})`，返回SDK native provider。导出`validateAgentPlanKey(key,options?:{fetchImpl?,signal?,timeoutMs?})`，公开返回valid/invalid/unavailable。测试本轮可以沿用这些公共接口，不读实现体或实施者测试。

通过真实DefaultResourceLoader/createAgentSession/ModelRuntime注册该provider；HTTP使用阻断未知URL的离线fetch或本地transport fixture，并经公共before_provider_request观察/保留实际body。两种真实adapter都要经过实际SDK请求构造，不能只mock一个registerProvider收集对象。认证方法可用合成AuthContext/Credential交互做纯边界控制；上下游成功流响应按对应SDK公开协议fixture，不猜私有字段。

原生provider模型/认证API的精确类型可从公开声明与ReturnType获取；无需复制目录或价格表。命中真实请求的host/path/header必须验证，但Authorization只用明显合成值且日志不包含真实秘密。测试meta与传输隔离避免环境fallback读真实key。

## 交付

只本provider必要源码/自有回归/双语README/包级docs/单独changeset；manifest若确有1.1最低运行时矛盾先报告，不修改锁/版本，不触及其它包。完整package check/types、真实loader/pack与两种adapter离线结果。独立作者交baseline分类，组合后审阅/集成复验；实现者不读写预留测试。无真实服务、推送、main或发布授权。
