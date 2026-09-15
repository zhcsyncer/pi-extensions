# pi-provider-volcengine-agent-plan

[English](./README.md)

用于[火山方舟 Agent Plan](https://www.volcengine.com/docs/82379/2366394) 的非官方 [Pi](https://github.com/earendil-works/pi-mono) provider。这是社区包，与火山引擎无隶属关系，也未获得官方背书。

## 功能

- 原生注册 Pi provider，集成 `/login`，并提供不启动推理的 API Key 校验。
- 静态维护 12 个 Agent Plan 模型，包含 DeepSeek V4.1 Flash（尝鲜版）、GLM 5.3 Flash 和 Doubao Seed 2.1 Turbo。
- 9 个模型支持图片输入；GLM 5.3、DeepSeek V4 Flash/Pro 仍仅文本。
- 支持流式、思考和工具调用，并适配网关的思考控制参数。
- 使用 OpenAI Responses；Kimi K2.7 Code 例外，使用 Chat Completions。

与[火山官方 Pi 指南](https://www.volcengine.com/docs/82379/2666474)的最小配置相比，本扩展额外提供登录校验、思考能力声明、参考费用估算和逐模型兼容处理。

## 要求

- Node.js 20 或更高版本，以及 Pi（已在 0.84 验证）。
- **Agent Plan 专属 API Key**，不能与普通方舟或 Coding Plan Key 混用。

## 安装与登录

```bash
pi install npm:pi-provider-volcengine-agent-plan
```

重启 Pi 或执行 `/reload`，然后运行：

```text
/login volcengine-agent-plan
```

输入 Agent Plan Key 和订阅套餐。无效 Key 会提示重新输入；临时验证失败时可以重试，或明确选择未经验证仍然保存。通过 `/model` 选择模型，也可检查目录：

```bash
pi --list-models volcengine-agent-plan
```

自动化环境可使用：

```bash
export ARK_AGENT_PLAN_API_KEY='...'
export ARK_AGENT_PLAN_TIER='medium'
```

也接受 `VOLCENGINE_ARK_PLAN_API_KEY`。套餐可取 `small`、`medium`、`large`、`max`，默认 `medium`。

## 模型与套餐

- Doubao Seed 2.0 Mini 和 Lite
- Doubao Seed 2.1 Turbo 和 Seed Evolving
- DeepSeek V4 Flash、V4 Pro 和 V4.1 Flash（尝鲜版）
- MiniMax M3
- GLM 5.3 和 GLM 5.3 Flash
- Kimi K2.7 Code 和 Kimi K3

Small 展示 11 个模型；Medium、Large、Max 展示全部 12 个。官方个人版套餐表仍要求 Kimi K3 使用 Medium 或以上套餐；仅在控制台看到模型卡片，并不能确认 Small 有调用权限。

已下线的 Seed 2.0 Code/Pro、MiniMax M2.7、Kimi K2.6、GLM 5.2 不再提供。如果之前选用了这些模型，请通过 `/model` 切换到替代模型。

## 思考与兼容性

- DeepSeek V4.1 Flash 提供 `off`、`low`、`high`、`max`，使用显式网关参数控制思考开关；Seed 2.1 Turbo 也支持显式开启、关闭思考。
- GLM 5.3 Flash、GLM 5.3 和 Kimi K3 提供 `low`、`high`、`max`，不提供 `off`。
- V4.1 Flash 和 GLM 5.3 Flash 对齐 Pi 原厂模型目录的 effort 声明，隐藏不支持的 `minimal`、`medium` 和 `xhigh`。
- Kimi K2.7 Code 不支持关闭思考；为保证工具调用兼容性，继续使用 Chat Completions。
- 请求成功不代表每个模型都会对不同 effort 档位表现出不同的思考强度。

## 费用估算与限制

Pi 展示公共 API 的参考资源费用，**不是 Agent Plan 账单或 AFP 消耗**。新增三款模型按固定估算汇率 7 元人民币/美元换算；DeepSeek V4.1 Flash 使用高峰参考价，不包含按小时计费的缓存存储。实际套餐计费与额度仍由火山引擎决定。

静态目录可能滞后于控制台变化。完整上下文、最大输出、并发和余量展示未经过线上极限测试。图片、视频、语音生成需要通过独立工具或 MCP 接入，不属于这些对话模型卡片的能力。

请勿将 API Key 提交到源码、问题报告或聊天消息。

## 许可证

MIT
