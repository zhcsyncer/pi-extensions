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

- 只有 bash 会向当前模型要 `displaySummary` 意图。其它内置工具只用确定性 target。
- Claude 风格：状态标记、`Name(target)`、缩进结果。
- 可选 `aggregate`：一次用户请求收成一条 Tools 账本。`Agent` 默认仍用自己的 renderer。
- 有界多行调用目标、缩进失败详情，以及 generic custom tool 的安全顶层参数预览。
- 保留上游的 compact / summary / preview 结果模式。
- 提供合作式 API，其它工具仍可自行选择同一意图字段。

不要同时加载 `pi-tool-display`、`pi-tool-display-summary` 和本扩展。它们会注册同名内置工具。

## 安装

```bash
pi install npm:@zhcsyncer/pi-tool-display-intent
pi install npm:@zhcsyncer/pi-extensions
```

然后重启 Pi 或执行 `/reload`。

## 使用

```text
/tools
/tools aggregate
/tools individual
```

空的 `/tools` 打开设置面板。切布局会先确认再保存并 reload。两种布局都能配置 bash intent 语言，修改后经 `/reload` 生效；其它展示旋钮按布局显示。

## 布局

`individual` 是默认：每个工具各占一行。

`aggregate` 把一次用户请求里所有已注册内置、custom、MCP 和延迟加载工具收进一条 Tools：

![收起的 Tools 账本](./assets/demo-aggregate-1.png)

![展开的 Tools 时间线](./assets/demo-aggregate-2.png)

![失败的 Tools 账本](./assets/demo-aggregate-3.png)

```text
◐ Tools (16 calls · 3 turns) · read ×12 · ask_user_question ×1 · edit ×8 · bash ×16
  › 先对照两边入口
  ◐ Bash — 把策略固化成 zone · 54 lines · 2.3KB           12s

✓ Tools (17 calls · 3 turns) · read ×12 · ask_user_question ×1 · edit ×8 · bash ×17
  ↳ 2 steers
  took 2m14s · tok ↑62k ↓8.4k R120k W4.1k · at 2026-04-08 14:32:14
```

进行中时，最新一条 assistant 旁白按 Markdown 停在标题下，最多三行。每条可见调用把耗时靠右放在首行，目标过长时最多再占一行。结束后旁白收起，mute 收据显示耗时、token、cache 和本地时间。收起时失败只显示 `N failed`。中途 steer 仍是同一本 Tools：进行中钉各条首行，结束后留一行 `↳ N steers`。`Ctrl+O` 展开原时间线，每条 `↳` 留在当时的位置，每条调用最多 8 行；失败详情另起缩进行。默认 `flat` 仍是逐条带时间；把 `toolCalls.expandedTimeline` 调成 `turns` 后，按拍显示 `↻ 1/3 · 3 calls` 拍头，调用行缩进，不用 reload。多行 bash 只显示 intent 和体积，不倒脚本。`Agent` 仍用原 renderer。图片 read 像其它 output 一样收进 Tools 账本。切回：`/tools individual`。

用户行固定用左侧强调色细杠。

## 设置

打开 `/tools`，或看 [`config/config.example.json`](./config/config.example.json)。

| 改什么 | 效果 |
|---|---|
| `toolCalls.layout` | `individual` 或 `aggregate` |
| `toolCalls.expandedTimeline` | `flat` 展开逐条，或 `turns` 按 agent turn 分组（仅 aggregate，不用 reload） |
| `results.mode` | `compact`、`summary` 或 `preview` |
| `intent.language` | bash intent 语言：尽量跟随请求、固定简体中文或固定英文（经 `/reload` 生效） |
| `diff.collapsedMode` | `body` 预览，或只要 `summary` 统计 |
| `tools.passthrough` | aggregate 里仍用原 renderer 的工具 |

旧的 `toolCalls.style` 和 `transcript.userMessageStyle` 会被丢掉。

## 自定义工具

没有 call-presentation adapter 的 generic custom tool 会显示安全、有界的顶层参数预览：总长最多 120 字符，标量值会缩短，数组和对象只显示形状，疑似凭据的键和值会脱敏。工具自己提供的 `getCallPresentation` 始终优先。

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
