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

或者从 Git 安装固定版本：

```bash
pi install git:github.com/zhcsyncer/pi-extensions@v0.2.0
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
/tool-display-intent preset minimal
/tool-display-intent preset balanced
/tool-display-intent preset detailed
```

修改工具 ownership 或意图 Schema 后需要执行 `/reload`。

`minimal`、`balanced` 和 `detailed` 是持久化的结果 Profile 基线：它们调整 read/search/MCP/bash 输出模式和折叠视觉行预算，但保留调用外框、意图、ownership、diff 及其他高级设置。旧名称 `opencode`、`verbose` 仍可作为命令别名。只有在需要恢复完整默认配置时才使用 `reset`。

## 配置

全局配置位置：

```text
$PI_CODING_AGENT_DIR/extensions/pi-tool-display-intent/config.json
```

未设置 `PI_CODING_AGENT_DIR` 时使用 Pi 默认 agent 目录。v2 配置按职责分组，并且只保存相对 Profile 和默认值的差异：

```json
{
  "$schema": "https://raw.githubusercontent.com/zhcsyncer/pi-extensions/main/packages/pi-tool-display-intent/config/config.schema.json",
  "version": 2,
  "intent": {
    "language": "zh-CN"
  },
  "toolCalls": {
    "frame": "claude"
  },
  "results": {
    "profile": "minimal",
    "previewRows": 10,
    "overrides": {
      "read": "summary",
      "search": "preview"
    }
  },
  "diff": {
    "layout": "auto",
    "indicators": "bars"
  },
  "transcript": {
    "userMessage": "boxed",
    "thinkingLabel": true
  }
}
```

完整模板见 [`config/config.example.json`](./config/config.example.json)，字段校验和编辑器补全见 [`config/config.schema.json`](./config/config.schema.json)。

| 分组 | 作用 |
|---|---|
| `extension` | 整体启停。通常应通过 Pi package 设置管理，不需要手写。 |
| `intent` | 模型意图的启停、语言和最大长度。 |
| `toolCalls` | `compact` 或 Claude Code 风格调用外框。 |
| `results` | 结果 Profile、共享预览视觉行预算和单工具 override。 |
| `diff` | edit/write diff 的布局、指示器、折行和行数。 |
| `transcript` | 用户消息框和 thinking label。 |
| `tools` | 禁用的内置工具 renderer 与自定义工具展示装饰。 |
| `advanced` | 展开上限、截断/RTK 提示和 debug。 |

结果 Profile 是持久化基线：

- `minimal`：调用头为主，bash 保留紧凑 inline 输出；
- `balanced`：read/MCP 使用摘要，搜索使用计数；
- `detailed`：read/search/MCP/bash 使用较大的 preview。

`results.overrides` 只保存相对基线的差异。搜索工具的 `summary` 表示计数摘要；bash 的 `inline` 对应紧凑的行内输出。旧命令名 `opencode` 和 `verbose` 仍分别作为 `minimal` 和 `detailed` 的兼容别名。

`results.previewRows` 和 `results.overrides.bash.collapsedRows` 统计终端折行后的视觉行，而不是按换行符分隔的逻辑行。因此，压缩 JSON、base64 或其他超长单行也会消耗配置的视觉行预算，并以 `long line truncated` 展开提示结束，不再刷满 transcript。`advanced.expandedLineLimit` 对展开后的结果预览采用相同的视觉行语义；配置为 `0` 时仍保留内部安全上限以防御异常输入。

### 历史配置自动迁移

扩展加载没有 `version` 的旧 flat 配置时，会在内存中规范化、验证 v2 round-trip 行为一致，然后立即原子更新原 `config.json`。首次迁移会保留一份 `config.legacy.json` 备份。迁移包括：

- `displaySummary` / `toolIntent` → `intent`；
- `toolCallStyle` → `toolCalls.frame`；
- 各种 `*OutputMode` → `results` Profile 与 overrides；
- `previewLines` → `results.previewRows`，`bashCollapsedLines` → `results.overrides.bash.collapsedRows`；
- `registerToolOverrides` → `tools.disabled`；
- `customToolOverrides` → `tools.custom`；
- diff、transcript、hint 和 debug 字段进入对应分组。

废弃的 `displaySummary.required` 和 `displaySummary.showInTui` 会被移除。无效 JSON、未知 v2 字段或错误值不会被自动改写，并会在 TUI 中报告具体字段路径。直接编辑配置后执行 `/reload` 重新读取。

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
  overrideExistingRenderers: true
}));
```

`withDisplaySummary` 会：

- 为自定义工具提供独立的 API 级 `required` 选项，不受内置工具 `intent` 配置影响；
- 在工具已经定义同名字段时拒绝包装，避免改变原字段语义；
- 保留并委托原始 `prepareArguments` 和 `execute`；
- 在适当阶段剥离展示参数；
- 支持幂等调用。

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
