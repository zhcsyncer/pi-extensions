# pi-tool-display-intent

[English](./README.md)

`pi-tool-display-intent` 是一个 Pi extension，将紧凑的工具展示与模型生成的用户可读意图合并在一起。

```text
read docs/tax-code.pdf — 检查 Colorado 税法
$ pnpm test — 验证 extension 测试套件
```

`displaySummary` 由当前模型在正常 tool call 中生成。这个 extension **不会**额外发起推理请求，不使用第二个模型，也不需要额外 API Key。

## 功能

- 为持有的 `read`、`grep`、`find`、`ls`、`bash`、`edit`、`write` Schema 添加 `displaySummary`。
- 在 TUI 中同时展示模型意图与路径、命令、pattern、diff 等确定性信息。
- 调用原始工具前剥离纯展示字段，保持工具执行语义不变。
- 在 Pi RPC 原始事件中保留该字段，供自定义 UI 显示进度。
- 后续模型请求前从上下文副本中清理旧意图，避免展示 token 累积；Session/RPC 历史不受影响。
- 渲染前清理终端控制序列，并限制摘要长度。
- 保留 fork 自 `pi-tool-display` 的输出折叠、MCP 展示、pending diff、edit/write diff、thinking label 和原生用户消息框。
- 为自定义工具提供合作式包装 API。

## 安装

只安装本包：

```bash
pi install npm:@zhcsyncer/pi-tool-display-intent
```

安装完整 extension bundle：

```bash
pi install npm:@zhcsyncer/pi-extensions
```

或者从 Git 安装固定版本：

```bash
pi install git:github.com/zhcsyncer/pi-extensions@v0.1.4
```

本地开发：

```bash
pi --no-extensions -e ./packages/pi-tool-display-intent
```

> 不要同时加载 `pi-tool-display`、`pi-tool-display-summary` 和本 extension。它们都会注册同名内置工具，结果是最后注册者覆盖前者，而不是自动合并 renderer。

## 使用

打开交互设置：

```text
/tool-display-intent
```

直接命令：

```text
/tool-display-intent show
/tool-display-intent reset
/tool-display-intent preset opencode
/tool-display-intent preset balanced
/tool-display-intent preset verbose
```

修改工具 ownership 或意图 Schema 后需要执行 `/reload`。

## 配置

全局配置位置：

```text
$PI_CODING_AGENT_DIR/extensions/pi-tool-display-intent/config.json
```

未设置 `PI_CODING_AGENT_DIR` 时使用 Pi 默认 agent 目录。完整模板见 [`config/config.example.json`](./config/config.example.json)。

意图相关配置：

```json
{
  "displaySummary": {
    "enabled": true,
    "required": true,
    "language": "auto",
    "showInTui": true,
    "maxLength": 96
  }
}
```

| 配置 | 默认值 | 含义 |
|---|---:|---|
| `enabled` | `true` | 为本 extension 持有的内置工具增加字段。 |
| `required` | `true` | 在模型可见 Schema 中将字段设为必填。 |
| `language` | `"auto"` | 支持 `auto`、`zh-CN`、`en`；auto 跟随用户主要语言。 |
| `showInTui` | `true` | 在确定性调用信息旁显示清理后的意图。 |
| `maxLength` | `96` | 接受和显示的最大长度，限制在 16～256 字符。 |

旧 Session 或不完整 tool call 缺少必填字段时，`prepareArguments` 会补充确定性 fallback，避免校验和执行失败。由于 Pi 在参数准备前发送 `tool_execution_start`，RPC 客户端仍应在原始事件没有摘要时自行 fallback。

其余展示配置继承自 `pi-tool-display`，包括：

- `readOutputMode`：`hidden`、`summary`、`preview`
- `searchOutputMode`：`hidden`、`count`、`preview`
- `mcpOutputMode`：`hidden`、`summary`、`preview`
- `bashOutputMode`：`opencode`、`summary`、`preview`
- diff 布局、指示器、行数限制、工具 ownership 和用户消息框设置

## 自定义工具

要给另一个 extension 的工具添加模型可见字段，需要工具提供方主动包装完整 definition，并且必须在 `pi.registerTool` 之前完成：

```ts
import {
  decorateToolForDisplay,
  withDisplaySummary,
} from "@zhcsyncer/pi-tool-display-intent/tool-display-api-consumer";
import { Type } from "typebox";

const tool = withDisplaySummary({
  name: "web_search",
  label: "Web Search",
  description: "Search the web.",
  parameters: Type.Object({
    query: Type.String()
  }),
  async execute(_toolCallId: string, args: { query: string }) {
    // 此处 args.displaySummary 已被删除。
    return runSearch(args.query);
  }
}, {
  language: "auto",
  required: true
});

pi.registerTool(decorateToolForDisplay(tool, {
  kind: "generic",
  overrideExistingRenderers: true
}));
```

`withDisplaySummary` 会：

- 在工具已经定义同名字段时拒绝包装，避免改变原字段语义；
- 保留并委托原始 `prepareArguments` 和 `execute`；
- 在适当阶段剥离展示参数；
- 支持幂等调用。

Pi 0.80.x 的 `getAllTools()` 公开返回元数据，而不是任意工具的完整 definition。因此不能把“仅配置工具名”视为给其他 extension 添加意图 Schema 的可靠方式。需要 Schema 和执行保证时，应使用合作式 wrapper；definition 可用时，`customToolOverrides` 仍可用于纯展示装饰。

## RPC 与模型上下文

RPC UI 可以直接读取原始调用：

```json
{
  "path": "docs/tax-code.pdf",
  "displaySummary": "检查 Colorado 税法"
}
```

后续调用模型前，extension 会从待发送的 assistant tool-call 参数副本中删除 `displaySummary`，避免纯展示 token 持续累积，同时不修改持久化 Session 或 RPC 历史。

## 安全与成本

- 不会产生额外推理请求；只在已有模型响应中消耗少量额外 token。
- 意图属于不可信模型输出。渲染前会清理 ANSI、OSC、控制字符、换行和超长内容。
- TUI 始终保留真实路径、命令和 pattern；不得使用意图文本进行授权、审计或执行判断。
- Schema 会提示模型不要包含秘密或凭据，但敏感工具仍应根据需要关闭该能力。

## 本地测试

先执行完整自动化校验：

```bash
pnpm --filter @zhcsyncer/pi-tool-display-intent check
```

然后只加载本 extension，避免已安装的 renderer extension 参与工具 ownership 竞争：

```bash
pi --no-extensions -e ./packages/pi-tool-display-intent
```

在 TUI 中运行：

```text
/tool-display-intent show
```

建议依次触发 `read`、`bash`、`grep`、`edit`，检查：

1. 调用行同时显示真实参数和模型意图；
2. 工具执行结果与原工具一致；
3. `/tool-display-intent` 设置界面可打开；
4. `/reload` 后工具和 renderer 正常恢复；
5. 原 `pi-tool-display` 与 `pi-tool-display-summary` 未同时加载。

测试整个仓库 bundle：

```bash
pi --no-extensions -e .
```

## 开发

```bash
pnpm --filter @zhcsyncer/pi-tool-display-intent typecheck
pnpm --filter @zhcsyncer/pi-tool-display-intent test
pnpm --filter @zhcsyncer/pi-tool-display-intent check
```

## 上游与来源声明

本包是以下项目的修改版：

- [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display) `0.5.0`，commit [`91cef7580078371f8dc49a8607222807ad6a424d`](https://github.com/MasuRii/pi-tool-display/commit/91cef7580078371f8dc49a8607222807ad6a424d)，Copyright © 2026 MasuRii，MIT License。
- `displaySummary` Schema 和委托机制改编自 [`mertdeveci5/pi-tool-display-summary`](https://github.com/mertdeveci5/pi-tool-display-summary) `0.1.0`，Copyright © 2026 Mert Deveci，MIT License。

原 `pi-tool-display` 许可证原文保存在 [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE)，其发版历史保存在 [`UPSTREAM_CHANGELOG.md`](./UPSTREAM_CHANGELOG.md)。合并后的版权和授权声明见 [`LICENSE`](./LICENSE)。

本 fork 的主要修改包括：模型意图 Schema、TUI 意图展示、上下文清理、自定义工具合作式 wrapper、独立 package/config/command 命名空间、pnpm workspace 集成，以及兼容 macOS 路径别名的 workspace preview 安全检查。

## License

MIT，见 [`LICENSE`](./LICENSE) 与 [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE)。
