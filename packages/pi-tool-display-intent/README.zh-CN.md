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
- 当前调用执行时若漏掉字段，使用按工具区分的确定性 fallback；恢复后未保存摘要的历史调用只显示 target。
- 渲染前清理终端控制序列，并限制摘要长度。
- 可选用 Claude Code 风格 TUI：状态标记、`Name(target)` 标题、无背景框调用行和缩进的 `⎿` 结果。
- 可选用 aggregate 布局，把一次用户请求中由本扩展持有的安全内置工具合并为有界 Activity。
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
/tool-display-intent layout individual
/tool-display-intent layout aggregate
/tool-display-intent mode compact
/tool-display-intent mode summary
/tool-display-intent mode preview
```

修改工具 ownership、layout、意图 Schema 或 renderer shell 后需要执行 `/reload`。历史命令 `preset minimal|balanced|detailed`、`opencode` 和 `verbose` 仍作为兼容别名接受。

## 配置

全局配置位置：

```text
$PI_CODING_AGENT_DIR/extension-data/pi-tool-display-intent/config.json
```

未设置 `PI_CODING_AGENT_DIR` 时使用 Pi 默认 agent 目录。显式启用 debug 后，日志写入 `$PI_CODING_AGENT_DIR/extension-data/pi-tool-display-intent/state/debug.log`。扩展启停统一通过 Pi package 设置管理，不再增加另一个配置开关。v2 按职责分组，只保存非默认值：

```json
{
  "$schema": "https://raw.githubusercontent.com/zhcsyncer/pi-extensions/main/packages/pi-tool-display-intent/config/config.schema.json",
  "version": 2,
  "intent": {
    "language": "zh-CN"
  },
  "toolCalls": {
    "layout": "aggregate",
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
| `toolCalls` | `layout`、`style`、`bashCommandPreviewRows` | 逐工具或聚合布局、调用外框和 Bash 命令参数折叠后的视觉行预算。 |
| `results` | `mode`、`previewRows` | 结果显示量和统一的折行后视觉行预算。 |
| `diff` | `layout`、`indicators`、`splitMinWidth`、`collapsedRows`、`collapsedMode`、`wordWrap` | edit/write diff 展示。`collapsedMode: summary` 在 Ctrl+O 前只显示 +N -M 统计行，最省空间；`body`（默认）保留 `collapsedRows` 行的预览。 |
| `transcript` | `userMessageStyle`、`thinkingLabel` | 用户消息和 reasoning 标签。 |
| `tools` | `passthrough`、`custom` | renderer ownership 和明确列出的自定义工具。 |
| `advanced` | `expandedRows`、`truncationHints`、`rtkCompactionHints`、`debug` | 展开安全上限和诊断。 |

`results.mode` 只有一层直接语义：

| mode | read/search/MCP | bash |
|---|---|---|
| `compact` | 隐藏结果正文 | 显示短预览 |
| `summary` | 显示数量或摘要 | 显示行数摘要 |
| `preview` | 显示内容预览 | 显示内容预览 |

所有内容预览，包括 custom tool、bash 流式和错误输出，都使用 `results.previewRows`，支持范围为 `2`–`80`。它统计终端折行后的视觉行，因此压缩 JSON、base64 或其他超长单行无法绕过限制。已有 v2 配置中的 `1` 会迁移为 `2`；`advanced.expandedRows` 单独限制展开后的输出。

### 工具调用布局

`toolCalls.layout` 默认是 `individual`，完整保留现有逐工具行为。`aggregate` 会把一次用户请求中由本扩展持有的 `read`、`grep`、`find`、`ls`、`bash`、`edit`、`write` 合并起来：

```text
◐ Activity · read ×12 · edit ×8 · bash ×16
  ◐ Bash(pnpm test)

✓ Activity · read ×12 · edit ×8 · bash ×17
  ✓ Bash(pnpm test) done
```

最新的 aggregate-safe 工具行承载 Activity，同组旧成员占用零行。Activity 最多按 assistant source order 显示三个运行中或刚完成的操作。成功行会先变成 `done`，而不是立即消失；新工具优先替换最早保留的 `done` 行，运行中工具始终优先占用槽位。Pi 报告 agent settled 后，最后的成功行继续停留 1.5 秒，再收进标题计数；失败行保持可见，不会自动收起。

各工具使用不同的主题感知颜色，其中 `edit` 和 `write` 使用加粗高强调样式。修改文件路径使用主题 accent，新增和删除分别使用 `toolDiffAdded` 与 `toolDiffRemoved`。工具名和状态符号始终保留，不会只靠颜色表达差异。edit/write 还会尽可能显示 unique files 和可准确计算的 `+A −B`；文件统计排在工具计数之前，因此窄窗口也会优先保留。同组会跨越多个底层 assistant/tool turn，只在下一条 user message 开始时结束。

Aggregate 始终保持有界：瞬态 `done` 行只存在于实时执行，不会在 reload、resume、tree 导航或 compaction 后重建。按 `Ctrl+O` 只展开最多 20 个修改文件路径及每文件可用的 `+A −B`，不会展示组内 output 或 diff body，也不会向本扩展持有的工具 Schema 添加 `displaySummary`。Pi 隐藏 reasoning block 时，aggregate 还会隐藏纯 assistant `Thinking...` 占位行；assistant 文本、错误以及通过 Pi thinking toggle 展开的真实 reasoning 仍正常显示。图片、交互或需注意的结果、passthrough 工具、外部持有的工具以及 unknown/custom tool 都保持独立，不会被静默隐藏。reload、resume、tree 导航和 compaction 会从当前 Session branch 重建 Activity，原始 tool call 与 result 不会被修改或删除。执行时可准确计算的 write diff 数量会保存在不可见的扩展 custom entry 中，因此重建后的 Activity 统计保持稳定，同时不会持久化旧文件内容。

Aggregate 期间，individual-only 偏好仍保留在 `config.json` 中；设置 TUI 会隐藏它们，`/tool-display-intent show` 会标记为 inactive。layout 变更在 `/reload` 后生效，并重绘整个当前 branch，而不是只影响未来调用。需要检查历史原始详情时，切回 individual 并 reload：

```text
/tool-display-intent layout individual
/reload
```

Aggregate 期间创建的调用没有生成 intent；切回 individual 后，历史行使用确定性 target 和原始保存结果。

`toolCalls.bashCommandPreviewRows` 单独控制 Bash 命令参数折叠后的视觉行预算，可设为 `1`–`8`，默认是 `1`。短命令保持行内展示；长命令或多行命令会附带准确的行数和大小信息。Claude 风格会把 intent 留在标题行，把命令预览放到独立行，并使用 accent 色强调该行的 shell prompt。按 `Ctrl+O` 可查看完整原始命令，并在安全限制内应用 Bash 语法高亮。该配置不影响命令输出。Claude 风格的 Bash 结果无论折叠还是展开，左侧线框都会贯穿到最后一行。

带路径的 `read`、`grep`、`find`、`ls`、`edit`、`write` 调用会原样保留短路径。如果完整调用标题即将折行，折叠视图会省略路径中段，同时保留有辨识度的开头目录和文件名。按 `Ctrl+O` 会恢复全部路径段，并允许完整标题正常折行；Home 路径仍统一显示为 `~`。

模型生成的 intent 使用主题的常规 `accent` 色，不加粗、不加背景。确定性的命令、路径和 query 使用普通 `text`；元数据、分隔符和确定性 fallback intent 继续使用 `muted`。

`tools.passthrough` 表示继续使用原 renderer 的内置工具，不会禁用工具。`tools.custom` 条目存在即启用展示装饰，例如：`"web_search": { "renderer": "generic", "mode": "summary" }`。bundle 私有的 Search Hub 已使用合作式 API，因此无需该配置；只有想固定模式而不继承 `results.mode` 时才需要添加。

### 历史配置自动迁移

首次加载时，扩展会自动把旧配置路径、legacy backup 和 debug log 迁入 `extension-data`。没有 `version` 的旧 flat 配置或 v2 之前的版本会被规范化，并在验证 v2 round-trip 后原子替换 `config.json`。首次 schema 迁移保留 `config.legacy.json`。主要映射：

- `displaySummary` / `toolIntent` → `intent`；
- `toolCallStyle` → `toolCalls.style`；
- 历史单工具输出模式 → 一个 `results.mode`；
- `previewLines` → `results.previewRows`；
- `registerToolOverrides` → `tools.passthrough`；
- `customToolOverrides` → 没有 `enabled` 开关的 `tools.custom`；
- diff、transcript、hint 和 debug → 对应分组。

`bashCollapsedLines` 会直接丢弃，因为所有预览统一使用 `results.previewRows`。废弃的 `displaySummary.required`、`displaySummary.showInTui`、未知字段和无法映射的无效值也会被丢弃；Pi 状态栏会报告准确字段路径。格式损坏的 JSON 和未来版本 schema 会原样保留并回退默认值。直接编辑配置后执行 `/reload` 重新读取。

在 `individual` 布局启用 `intent.enabled` 后，`displaySummary` 在本 extension 持有的内置工具 Schema 中固定为必填并始终显示。当前正在执行的 tool call 缺少字段时，renderer 会显示确定性 fallback，`prepareArguments` 也会在校验前回填参数；恢复出的历史调用如果没有已保存摘要，则只显示 target，避免 aggregate 历史在切换布局后获得伪造 intent。由于 Pi 在参数准备前发送第一次 `tool_execution_start`，RPC 客户端仍应为该初始事件自行 fallback。

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

对于共用的 generic 与 MCP renderer，失败结果即使处于 `hidden` 模式，也会从第一条有效 `content` 文本生成一行错误色摘要；按 `Ctrl+O` 后会在现有展开行预算内显示完整错误内容。错误 content 为空时回退为 `Tool failed.`。成功的 `hidden` 结果仍保持隐藏，语义 presentation 也不会覆盖由 content 提取的失败原因。

Pi 0.80.x 的 `getAllTools()` 公开返回元数据，而不是任意工具的完整 definition。因此不能把“仅配置工具名”视为给其他 extension 添加意图 Schema 的可靠方式。需要 Schema 和执行保证时，应使用合作式 wrapper；definition 可用时，`tools.custom` 仍可用于纯展示装饰。

## RPC 与模型上下文

RPC UI 可以直接读取原始调用：

```json
{
  "path": "docs/tax-code.pdf",
  "displaySummary": "检查 Colorado 税法"
}
```

在 individual 布局中，extension 会在后续模型上下文中保留 `displaySummary`。这会增加少量 token，但能给模型持续提供正确示例，避免恢复旧 Session 或连续工具 turn 时反向教会模型省略必填字段。持久化 Session 与 RPC 历史同样保留该参数。Aggregate 不注册、也不生成这个字段。

## 安全与成本

- 不会产生额外推理请求；只在已有模型响应中消耗少量额外 token。
- 意图属于不可信模型输出。渲染前会清理 ANSI、OSC、控制字符、换行和超长内容。
- TUI 保留确定性的路径、命令和 pattern；缩略路径可通过 `Ctrl+O` 查看完整内容。不得使用意图文本进行授权、审计或执行判断。
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
