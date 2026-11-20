# Agent Plan 兼容边界

Agent Plan 是独立订阅渠道，不是普通方舟、Moonshot 或 OpenAI API key 服务的别名。模型同名不能作为切换渠道的依据；参考 API cost 也不能解释为订阅账单或额度消耗。

## Pi 1.1

保留 native provider 和 Pi 原生 Responses / Chat Completions adapter，而不复制流处理。这样成功、取消和错误继续遵循 SDK 语义。目录按 API 区分 compat 类型，避免将一个协议的兼容选项误放到另一个协议。

Plan 的显式 thinking 开关只是网关控制。不能用它替换或删除 Responses 原有的 reasoning/include：那些字段也承担思考流和回放职责。Kimi K2.7 Code 仍使用 Chat Completions，其历史 assistant 消息必须保留 reasoning_content，缺少思考内容时也需按兼容规则补空值。

## 离线验证

包测试包含真实 DefaultResourceLoader → createAgentSession → ModelRuntime 注册，以及两种真实 adapter 的 HTTP 请求构造与 SSE 消费。fixture 只接受 Agent Plan 的两个完整请求 URL；其余请求拒绝。合成凭证、临时资源目录和内存 credential/model store 避免读取个人状态。

在仓库根目录、已选择目标 Node/Pnpm 的 PATH 下运行：

```bash
node scripts/run-isolated.mjs pnpm --filter pi-provider-volcengine-agent-plan check
node scripts/run-isolated.mjs env PI_OFFLINE=1 ARK_AGENT_PLAN_API_KEY=synthetic-loader-key ARK_AGENT_PLAN_TIER=small pnpm --filter pi-provider-volcengine-agent-plan exec pi --no-extensions -e . --list-models volcengine-agent-plan
```

`run-isolated.mjs` 使用独立网络命名空间阻断外网，同时清空个人配置和凭证环境；仅设置 `PI_OFFLINE=1` 不能代替网络隔离。目标 Pi 1.1 自身要求 Node.js >=22.19.0。

fixture 验证的是本包与已安装 SDK 的请求/流契约，不证明真实服务当前接受这些请求，也不覆盖真实登录、账户、额度、最大上下文或推理效果。未授权时不得用真实请求补验。
