# @zhcsyncer/pi-context7

[English](./README.md)

面向 [Pi coding agent](https://pi.dev) 的 Context7 文档工具。注册 `resolve-library-id` 与 `query-docs`，并附带完整上游 `context7-docs` Skill。

本包也会嵌入聚合包 `@zhcsyncer/pi-extensions`。

## 安装

单独安装：

```bash
pi install npm:@zhcsyncer/pi-context7
```

或安装完整 extension bundle：

```bash
pi install npm:@zhcsyncer/pi-extensions
```

不安装直接试用：

```bash
pi -e npm:@zhcsyncer/pi-context7
```

## 工具

### `resolve-library-id`

将包名或产品名解析为 Context7 兼容的 library ID，并返回带声誉与 snippet 元数据的候选列表。除非用户已直接提供 `/org/project` 或 `/org/project/version` 形式的 ID，否则应先调用此工具。

### `query-docs`

按已解析的 library ID 拉取最新文档与代码示例。每次调用应聚焦单一概念。

## Skill

`context7-docs` Skill 指导代理在需要时使用这些工具，而不是依赖训练数据。完整保留上游 Skill 文本。

## 鉴权

未配置时按 IP 速率限制可用。更高配额可在 [context7.com/dashboard](https://context7.com/dashboard) 生成免费密钥，并写入扩展配置文件：

```bash
mkdir -p "$PI_CODING_AGENT_DIR/extension-data/pi-context7"
cat > "$PI_CODING_AGENT_DIR/extension-data/pi-context7/config.json" <<'EOF'
{
  "apiKey": "ctx7sk_..."
}
EOF
```

未设置 `PI_CODING_AGENT_DIR` 时，默认路径为 `~/.pi/agent/extension-data/pi-context7/config.json`。

`CONTEXT7_API_KEY` 仍可作为脚本/CI 的可选回退；两者同时存在时以配置文件为准。

## 展示

两个工具各自实现紧凑 TUI 渲染：

- 调用行显示 `Context7 Resolve <libraryName>` 或 `Context7 Query <libraryId>`；
- 折叠结果行显示成功状态与简短摘要；
- resolve 摘要包含候选数量和 top library ID；
- query 摘要包含 UTF-8 大小、行数，以及尊重当前键位配置的展开提示；
- 展开后通过 Pi 原生 Markdown 渲染完整、与模型一致的内容；
- HTTP 与执行错误使用错误样式，并由 Pi 标记为 tool error。

tool result 的 `details` 只保存上述渲染所需的最小元数据。发给模型的文本内容保持与上游 Context7 输出一致。

## 本地开发

```bash
pnpm --filter @zhcsyncer/pi-context7 check
pi --no-extensions -e ./packages/pi-context7 --list-models nope
```

## 许可证

MIT。fork 自 [`@upstash/context7-pi`](https://github.com/upstash/context7)。详见 [`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md)、[`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE) 与 [`LICENSE`](./LICENSE)。
