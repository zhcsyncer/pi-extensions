# pi-provider-volcengine-agent-plan

[English](./README.md)

用于火山方舟 Agent Plan `https://ark.cn-beijing.volces.com/api/plan/v3` 的非官方 [Pi](https://github.com/badlogic/pi-mono) provider 扩展。

这是社区包，与火山引擎无隶属关系，也未获得火山引擎官方背书。

## 功能

- 原生注册 Pi provider，并集成 `/login`。
- 静态维护当前 13 个 Agent Plan 文本模型。
- 按 Small、Medium、Large 和 Max 套餐过滤可用模型。
- 默认使用 OpenAI Responses；Kimi K2.6 和 Kimi K2.7 Code 路由到 Chat Completions。
- 已通过 Agent Plan 网关验证流式、reasoning 和工具调用。
- 处理 MiniMax M2.7 和 Kimi K2.6 的 thinking 请求兼容性。
- Pi 持久化登录凭证前执行零推理 API Key 校验。

## 要求

- Node.js 20 或更高版本。
- Pi 和 `@earendil-works/pi-ai` 0.81.1，或兼容的 0.81 版本。
- Agent Plan 专属 API Key。普通火山方舟 API Key 不能用于 Plan 端点。

## 安装

```bash
pi install npm:pi-provider-volcengine-agent-plan
```

重启 Pi 或执行 `/reload`，然后检查模型目录：

```bash
pi --list-models volcengine-agent-plan
```

## 登录与凭证

### 交互登录

执行：

```text
/login volcengine-agent-plan
```

Pi 会提示输入 Agent Plan 专属 API Key 和已订阅套餐。登录流程会发送一个已鉴权但故意缺少参数的 Responses 请求：有效 Key 会到达 `MissingParameter`，无效或无权限的 Key 返回 401/403，并提示重新输入。该校验不会启动模型推理。

Pi 将 API Key 和套餐保存到标准凭证文件，通常为 `~/.pi/agent/auth.json`。本包不会读取自定义 Key 文件。

### 环境变量

推荐使用交互登录。自动化环境也可以提供环境凭证：

```bash
export ARK_AGENT_PLAN_API_KEY='...'
export ARK_AGENT_PLAN_TIER='medium'
```

也支持使用 `VOLCENGINE_ARK_PLAN_API_KEY` 作为 API Key fallback。套餐可取 `small`、`medium`、`large` 或 `max`；未配置套餐时默认使用 `medium`。

## 模型与套餐

当前目录包含：

- Doubao Seed 2.0 Mini、Lite、Code 和 Pro
- Doubao Seed Evolving
- DeepSeek V4 Flash 和 Pro
- MiniMax M2.7 和 M3
- GLM 5.2
- Kimi K2.6、Kimi K2.7 Code 和 Kimi K3

Small 展示 12 个模型。Kimi K3 当前要求 Medium 或更高套餐。Medium、Large 和 Max 展示当前全部 13 个文本模型。

## 兼容性

Kimi K2.6 和 Kimi K2.7 Code 使用 Chat Completions，因为兼容性测试中它们通过 Agent Plan Responses 执行工具调用会重复返回服务端错误。其余目录模型使用 Responses。

当前网关不支持关闭 Kimi K2.7 Code 的 thinking。Pi 选择 `off` 时，本包不会发送不受支持的禁用参数，但无法保证模型停止内部推理。

## 安全

Pi 标准 `auth.json` 由文件系统权限保护，但不是操作系统 Keychain。请勿提交凭证、将凭证粘贴到 issue，或把凭证写入项目配置。

API Key 校验请求不会记录 Key 或响应正文。遇到临时网络或服务错误时，用户可以重试、取消，或明确选择未经验证仍然保存。

## 开发

在仓库根目录运行：

```bash
pnpm --filter pi-provider-volcengine-agent-plan check
pi --no-extensions -e ./providers/pi-provider-volcengine-agent-plan --list-models volcengine-agent-plan
npm pack --dry-run --json ./providers/pi-provider-volcengine-agent-plan
```

单元测试使用模拟凭证和 fetch 响应。需要真实 Key 的契约测试不会进入普通 CI。

## 限制

Agent Plan 没有可用的 `/models` 端点，因此模型目录和元数据采用静态版本维护。火山引擎可能在本包更新前修改别名、协议行为、限制或套餐权限。

本包目前只声明文本输入。图片输入、极限上下文、最大长度输出、并发、限流和套餐余量展示不在当前覆盖范围内。

## 许可证

MIT
