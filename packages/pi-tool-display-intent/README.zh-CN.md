# pi-tool-display-intent

[English](./README.md)

`pi-tool-display-intent` 是一个 Pi extension，将紧凑的工具展示与模型生成的用户可读意图合并在一起。

```text
read docs/tax-code.pdf — 检查 Colorado 税法
$ pnpm test — 验证 extension 测试套件

● Read(docs/tax-code.pdf) — 检查 Colorado 税法
  ⎿ loaded 42 lines
```

`displaySummary` 由当前模型在正常 tool call 中生成。这个 extension **不会**额外发起推理请求，不使用第二个模型，也不需要额外 API Key。

## 功能

- 为持有的 `read`、`grep`、`find`、`ls`、`bash`、`edit`、`write` Schema 添加 `displaySummary`。
- 使用一条可由 Pi 去重的 system prompt guideline，同时在各工具 Schema 中保留字段级意图说明。
- 在 TUI 中同时展示模型意图与路径、命令、pattern、diff 等确定性信息。
- 调用原始工具前剥离纯展示字段，保持工具执行语义不变。
- 在 Pi RPC 原始事件及后续模型上下文中保留该字段，让 follow-up 调用继续生成意图。
- 模型或历史调用漏掉字段时，使用按工具区分的确定性 fallback。
- 渲染前清理终端控制序列，并限制摘要长度。
- 可选用 Claude Code 风格 TUI：状态标记、`Name(target)` 标题、无背景框调用行和缩进的 `⎿` 结果。
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

或者从 Git 安装 bundle：

```bash
pi install git:github.com/zhcsyncer/pi-extensions
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
/tool-display-intent mode compact
/tool-display-intent mode summary
/tool-display-intent mode preview
```

修改工具 ownership 或意图 Schema 后需要执行 `/reload`。历史命令 `preset minimal|balanced|detailed`、`opencode` 和 `verbose` 仍作为兼容别名接受。

## 配置

全局配置位置：

```text
$PI_CODING_AGENT_DIR/extensions/pi-tool-display-intent/config.json
```

未设置 `PI_CODING_AGENT_DIR` 时使用 Pi 默认 agent 目录。扩展启停统一通过 Pi package 设置管理，不再增加另一个配置开关。v2 按职责分组，只保存非默认值：

```json
{
  "$schema": "https://raw.githubusercontent.com/zhcsyncer/pi-extensions/main/packages/pi-tool-display-intent/config/config.schema.json",
  "version": 2,
  "intent": {
    "language": "zh-CN"
  },
  "toolCalls": {
    "style": "claude",
    "bashCommandPreviewRows": 1
  },
  "results": {
    "mode": "summary",
    "previewRows": 10
  }
}
```

所有可配置字段见 [`config/config.example.json`](./config/config.example.json)，严格校验和编辑器补全见 [`config/config.schema.json`](./config/config.schema.json)。

| 分组 | 可配置字段 | 作用 |
|---|---|---|
| `intent` | `enabled`、`language`、`maxLength` | 模型生成的工具调用意图。 |
| `toolCalls` | `style`、`bashCommandPreviewRows` | 调用外框和 Bash 命令参数折叠后的视觉行预算。 |
| `results` | `mode`、`previewRows` | 结果显示量和统一的折行后视觉行预算。 |
| `diff` | `layout`、`indicators`、`splitMinWidth`、`collapsedRows`、`wordWrap` | edit/write diff 展示。 |
| `transcript` | `userMessageStyle`、`thinkingLabel` | 用户消息和 reasoning 标签。 |
| `tools` | `passthrough`、`custom` | renderer ownership 和明确列出的自定义工具。 |
| `advanced` | `expandedRows`、`truncationHints`、`rtkCompactionHints`、`debug` | 展开安全上限和诊断。 |

`results.mode` 只有一层直接语义：

| mode | read/search/MCP | bash |
|---|---|---|
| `compact` | 隐藏结果正文 | 显示短预览 |
| `summary` | 显示数量或摘要 | 显示行数摘要 |
| `preview` | 显示内容预览 | 显示内容预览 |

所有内容预览，包括 custom tool、bash 流式和错误输出，都使用 `results.previewRows`。它统计终端折行后的视觉行，因此压缩 JSON、base64 或其他超长单行无法绕过限制。`advanced.expandedRows` 单独限制展开后的输出。

`toolCalls.bashCommandPreviewRows` 单独控制 Bash 命令参数折叠后的视觉行预算，可设为 `1`–`8`，默认是 `1`。短命令保持行内展示；长命令或多行命令会附带准确的行数和大小信息。Claude 风格会把 intent 留在标题行，并把命令预览放到独立行。按 `Ctrl+O` 可查看完整原始命令。该配置不影响命令输出。

模型生成的 intent 使用主题的常规 `accent` 色，不加粗、不加背景。确定性的命令、路径和 query 使用普通 `text`；元数据、分隔符和确定性 fallback intent 继续使用 `muted`。

`tools.passthrough` 表示继续使用原 renderer 的内置工具，不会禁用工具。`tools.custom` 条目存在即启用展示装饰，例如：`"web_search": { "renderer": "generic", "mode": "summary" }`。bundle 私有的 Search Hub 已使用合作式 API，因此无需该配置；只有想固定模式而不继承 `results.mode` 时才需要添加。

### 历史配置自动迁移

扩展加载没有 `version` 的旧 flat 配置时，会规范化配置，并在验证 v2 round-trip 后原子替换 `config.json`。首次迁移保留 `config.legacy.json`。主要映射：

- `displaySummary` / `toolIntent` → `intent`；
- `toolCallStyle` → `toolCalls.style`；
- 历史单工具输出模式 → 一个 `results.mode`；
- `previewLines` → `results.previewRows`；
- `registerToolOverrides` → `tools.passthrough`；
- `customToolOverrides` → 没有 `enabled` 开关的 `tools.custom`；
- diff、transcript、hint 和 debug → 对应分组。

`bashCollapsedLines` 会直接丢弃，因为所有预览统一使用 `results.previewRows`。迁移完成后，Pi 状态栏会提示用户按需调整该值。废弃的 `displaySummary.required` 和 `displaySummary.showInTui` 也会移除。无效 JSON、未知 v2 字段或错误的 v2 值不会被改写，并会报告准确字段路径。直接编辑配置后执行 `/reload` 重新读取。

启用 `intent.enabled` 后，`displaySummary` 在本 extension 持有的内置工具 Schema 中固定为必填并始终显示。旧 Session 或不完整 tool call 缺少字段时，renderer 会显示确定性 fallback，`prepareArguments` 也会在校验前回填参数。由于 Pi 在参数准备前发送第一次 `tool_execution_start`，RPC 客户端仍应为该初始事件自行 fallback。

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
  outputMode: "inherit",
  overrideExistingRenderers: true
}));
```

`withDisplaySummary` 会：

- 为自定义工具提供独立的 API 级 `required` 选项，不受内置工具 `intent` 配置影响；
- 在工具已经定义同名字段时拒绝包装，避免改变原字段语义；
- 保留并委托原始 `prepareArguments` 和 `execute`；
- 在适当阶段剥离展示参数；
- 支持幂等调用。

`decorateToolForDisplay` 提供统一的调用行渲染。对于 `generic` 工具，设置 `outputMode` 还会启用统一结果渲染：`inherit` 跟随全局 `results.mode`，`hidden`、`summary` 和 `preview` 则固定该工具的结果模式。不设置 `outputMode` 时会保留工具原有的结果 renderer。工具提供方还可以通过 `getCallPresentation` 返回主目标与元数据，用语义字段替代通用 `(N args)`；通过 `getResultPresentation` 返回结果状态与 `previewStartLine`，在共享视觉行预算内展示 backend、数量等摘要并跳过重复的原始头部。这些文本会被单行清理，回调失败时自动退回通用展示。

Pi 0.80.x 的 `getAllTools()` 公开返回元数据，而不是任意工具的完整 definition。因此不能把“仅配置工具名”视为给其他 extension 添加意图 Schema 的可靠方式。需要 Schema 和执行保证时，应使用合作式 wrapper；definition 可用时，`tools.custom` 仍可用于纯展示装饰。

## RPC 与模型上下文

RPC UI 可以直接读取原始调用：

```json
{
  "path": "docs/tax-code.pdf",
  "displaySummary": "检查 Colorado 税法"
}
```

extension 会在后续模型上下文中保留 `displaySummary`。这会增加少量 token，但能给模型持续提供正确示例，避免恢复旧 Session 或连续工具 turn 时反向教会模型省略必填字段。持久化 Session 与 RPC 历史同样保留该参数。

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

本 fork 的主要修改包括：模型意图 Schema、确定性 fallback、可选的 Claude Code 风格 TUI、自定义工具合作式 wrapper、独立 package/config/command 命名空间、pnpm workspace 集成，以及兼容 macOS 路径别名的 workspace preview 安全检查。

## License

MIT，见 [`LICENSE`](./LICENSE) 与 [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE)。
