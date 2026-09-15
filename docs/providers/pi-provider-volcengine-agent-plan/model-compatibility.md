# Agent Plan 模型维护边界

## 来源与权限

模型目录继续静态维护，不引入 SSO、AK/SK 或控制面依赖。2026-09-15 使用有效 Plan Key 实测 `GET /api/plan/v3/models` 返回 404；官方 CLI 的套餐模型查询属于另一个鉴权边界，不能视为现有 Key 可用的发现接口。

维护时交叉核对：

- [个人版套餐表](https://www.volcengine.com/docs/82379/2366394)：可用模型、套餐权限和长度。
- [官方 Pi 接入](https://www.volcengine.com/docs/82379/2666474)：精确 token 数值和输入模态；不要把其中省略 reasoning 的最小示例解释为不支持思考。
- [模型下线公告](https://www.volcengine.com/docs/82379/2578673)：区分停止服务和旧 ID 自动路由。
- [API 价格表](https://www.volcengine.com/docs/82379/1544106)：公共按量参考价格，不是 AFP。

网页 reader 可能只返回导航，不代表正文是图片或信息不存在。上述文档可通过公开匿名接口 `https://www.volcengine.com/api/doc/getDocDetail?LibraryID=82379&DocumentID=<id>` 的 `Result.MDContent` 读取。这只是文档取证途径，不作为 provider 的运行时依赖。

控制台“可配置模型”卡片不等于账号权益表。当前卡片写 Kimi K3 对 Small/Lite“不建议使用”，但个人版表明确 Small ×、Medium+ √；在权限证据改变前保留 Medium 门槛。不要套用企业版套餐权限。

精确长度优先使用官方 Pi 示例，不将其中的 1,048,576、262,144、393,216、32,768 按十进制 k 重新取整。MiniMax M3 的个人版套餐表明确为 1024k 上下文。Kimi K3 仍与 Pi 上游能力取交集，因此实际上限可能低于路由限额。

## 原厂基线与火山覆盖

`getBuiltinModel()` 只读取随 pi-ai 包发布的快照，并不是 Pi 运行时模型目录；后者可从 `pi.dev/api/models/providers/<provider>` 联网刷新。维护新模型时要检查最新在线目录和模型名称/别名，不能仅凭本地旧包按 ID 查不到就判断 Pi 没有收录。

采用“原厂能力基线 + 火山差异覆盖”，但不在运行时自动追随原厂升级：原厂上线并不证明火山路由同步支持，否则新目录可能使原本可用的请求突然失败。

2026-09-15 对照的原厂目录：[DeepSeek](https://pi.dev/api/models/providers/deepseek)、[Z.ai](https://pi.dev/api/models/providers/zai)、[Moonshot](https://pi.dev/api/models/providers/moonshotai)、[MiniMax](https://pi.dev/api/models/providers/minimax)。其中 DeepSeek V4.1 Flash 的原厂 ID 是 `deepseek-flash`，不同于火山 ID。

- DeepSeek V4.1 Flash 和 GLM 5.3 Flash 的 effort 档位采用原厂在线卡的静态快照，不提供原厂未声明的 minimal/medium/xhigh；GLM 禁止 off 与火山实测一致。
- 上下文和输出长度继续以火山资料为路由覆盖，不强制与原厂取相同数值。原厂 MiniMax M3 的 512k 输出上限不能直接替换火山的 128k；1,000,000 与 1,048,576 的目录差异也不证明实际能力提升。
- 协议和兼容字段不直接继承：原厂 DeepSeek/GLM/Kimi 的 Chat、MiniMax 的 Anthropic，不等于火山必须使用这些协议。
- Pi 尚无豆包原厂 provider，Seed 2.1 Turbo 以火山资料为基线；不能拿聚合商模型卡冒充原厂。

## 请求兼容性的负知识

- 官方 Pi 示例全用 Chat Completions，不意味着 Responses 不受支持。保留已有 Responses 路由；Kimi K2.7 Code 曾在 Responses 工具路径重复报服务端错误，继续单独用 Chat。
- 2026-09-15 新增三款模型均通过 Responses 图片识别、流式工具调用；也通过实际 Pi 适配器的工具结果续接。测试仅发送合成内容，不执行模型工具，不测满上下文或输出上限。
- DeepSeek V4.1 Flash 在 `reasoning.effort: none` 下仍返回 reasoning；显式 `thinking.type: disabled` 才关闭。Seed 2.1 Turbo 也接受显式开关。两者的 hook 保留 reasoning/include 和工具历史，不能沿用已下线 MiniMax M2.7 的参数删除逻辑。
- GLM 5.3 Flash 对 `thinking.type: disabled` 返回 `InvalidParameter`，因此不提供 off。不能仅凭一次工具调用没有 reasoning token 就断定支持关闭思考。
- 三款新增模型甚至接受无效的 effort 字符串；HTTP 200 不能证明档位语义被执行。V4.1 Flash、GLM 5.3 Flash 的 `max` 来自各自原厂在线卡，而不是根据网关接受参数推断；也不把 GLM 5.3 的枚举强套给 Flash。

## 参考价格的边界

新增模型未出现在仓库锁定的 pi-ai 0.84 内置快照中，因此本地保存核对后的能力声明与火山 API 参考价，不引入对新版内置卡的硬依赖。在线目录已收录原厂 DeepSeek/GLM 模型，不代表旧包的 `getBuiltinModel()` 能读取到。

新卡以固定 **7 CNY/USD 的估算口径**换算常规在线价格，不声称这是实时汇率。DeepSeek V4.1 Flash 取高峰价作为静态参考，不随时段改变历史会话估价。缓存存储价格按小时计费，不能填入按 token 计费的 `cacheWrite`；暂不估算这部分费用。未来上游模型卡可用后，仍需保留 Agent Plan 自己的路由和权限边界。

## 本地验证

```bash
pnpm --filter pi-provider-volcengine-agent-plan check
pnpm --filter pi-provider-volcengine-agent-plan exec pi --no-extensions -e . --list-models volcengine-agent-plan
npm pack --dry-run --json ./providers/pi-provider-volcengine-agent-plan
```

普通 CI 不使用真实凭据或发起推理。真实网关回归需要另行控制请求预算，且不得输出密钥。
