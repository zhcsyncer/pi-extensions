# pi-tool-display-intent

[English](./README.md)

![收起的 Tools 账本](./assets/demo-aggregate-1.png)

`pi-tool-display-intent` 是 [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display) 0.5.0 的维护 fork，保留紧凑工具展示，并加上模型写的用户可读意图。`displaySummary` 改编自 [`mertdeveci5/pi-tool-display-summary`](https://github.com/mertdeveci5/pi-tool-display-summary) 0.1.0。

```text
read docs/tax-code.pdf — 检查 Colorado 税法
$ pnpm test — 验证 extension 测试套件

● Read(docs/tax-code.pdf) — 检查 Colorado 税法
  ⎿ loaded 42 lines
```

当前模型在正常 tool call 里写 `displaySummary`。这个扩展**不会**再发起一次推理，也不需要第二个模型或额外 API Key。

## 功能

- 在持有的 `read`、`grep`、`find`、`ls`、`bash`、`edit`、`write` 旁同时显示意图和路径 / 命令 / pattern / diff。
- 可选 Claude 风格：状态标记、`Name(target)`、缩进结果。
- 可选 `aggregate`：一次用户请求收成一条 Tools 账本。`Agent` 默认仍用自己的 renderer。
- 保留上游的 compact / summary / preview 结果模式。
- 提供合作式 API，让其他工具也能加同一意图字段。

不要同时加载 `pi-tool-display`、`pi-tool-display-summary` 和本扩展。它们会注册同名内置工具。

## 安装

```bash
pi install npm:@zhcsyncer/pi-tool-display-intent
pi install npm:@zhcsyncer/pi-extensions
```

然后重启 Pi 或执行 `/reload`。

## 使用

```text
/tool-display-intent
/tool-display-intent show
/tool-display-intent reset
/tool-display-intent layout individual
/tool-display-intent layout aggregate
/tool-display-intent mode compact
/tool-display-intent mode summary
/tool-display-intent mode preview
```

改 layout 或 ownership 后需要 `/reload`。

## 布局

`individual` 是默认：每个工具各占一行。

`aggregate` 把一次用户请求里所有已注册内置、custom、MCP 和延迟加载工具收进一条 Tools：

![收起的 Tools 账本](./assets/demo-aggregate-1.png)

![展开的 Tools 时间线](./assets/demo-aggregate-2.png)

![失败的 Tools 账本](./assets/demo-aggregate-3.png)

```text
◐ Tools (16 calls · 3 turns) · read ×12 · ask_user_question ×1 · edit ×8 · bash ×16
  › 先对照两边入口
  ◐ Bash(pnpm test)

✓ Tools (17 calls · 3 turns) · read ×12 · ask_user_question ×1 · edit ×8 · bash ×17
  took 2m14s · tok ↑62k ↓8.4k R120k W4.1k · at 2026-04-08 14:32:14
```

进行中时，最新一条 assistant 旁白按 Markdown 停在标题下，最多三行。结束后旁白收起，mute 收据显示耗时、token、cache 和本地时间。收起时失败只显示 `N failed`。`Ctrl+O` 展开原时间线，不倾倒文件内容或 diff。图片和 `Agent` 仍用原 renderer。切回：`/tool-display-intent layout individual` 再 `/reload`。

Aggregate 固定用左侧强调色细杠的用户行。

## 设置

打开 `/tool-display-intent`，或看 [`config/config.example.json`](./config/config.example.json)。

| 改什么 | 效果 |
|---|---|
| `toolCalls.layout` | `individual` 或 `aggregate` |
| `toolCalls.style` | 默认或 Claude 风格 |
| `results.mode` | `compact`、`summary` 或 `preview` |
| `intent.language` | 模型意图语言 |
| `diff.collapsedMode` | `body` 预览，或只要 `summary` 统计 |
| `tools.passthrough` | aggregate 里仍用原 renderer 的工具 |

旧的 `transcript.thinkingLabel` 设置会被丢掉。

## 自定义工具

若要同一意图字段，在 `pi.registerTool` **之前**包装：

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

## 许可证

MIT。见 [`LICENSE`](./LICENSE) 与 [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE)。
