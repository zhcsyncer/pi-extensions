# @zhcsyncer/pi-context7

[English](./README.md)

面向 [Pi coding agent](https://pi.dev) 的 Context7 文档工具，支持 Pi 1.1+。fork 自 [`@upstash/context7-pi`](https://github.com/upstash/context7)，增加紧凑结果预览、配置文件鉴权，并让 `context7-docs` Skill 同时支持本包的 REST 工具与用户配置的原生 Context7 MCP 服务。

REST 扩展仍是默认入口，`@zhcsyncer/pi-extensions` bundle 也保持此默认；不依赖 MCP 或 codemode。

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

## 工具与 Skill

- `resolve-library-id` 查找 Context7 library ID 并返回排序候选。除非用户已提供 `/org/project` 或 `/org/project/version`，否则先调用它。
- `query-docs` 获取该 ID 对应的文档与示例。每次调用聚焦一个概念。
- `context7-docs` 按实际可用的旧工具或已核验的原生 MCP 工具指导查询，保留先解析后查询、每个问题每种操作最多三次、不发送敏感信息的规则。

结果提供紧凑预览，展开可阅读完整返回文本；失败会作为工具错误报告。

## REST 鉴权

REST 工具支持受 IP 速率限制的无密钥请求。如需更高配额，在 [context7.com/dashboard](https://context7.com/dashboard) 获取密钥并保存为 `apiKey`：

```bash
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$agent_dir/extension-data/pi-context7"
cat > "$agent_dir/extension-data/pi-context7/config.json" <<'EOF'
{
  "apiKey": "ctx7sk_..."
}
EOF
```

`CONTEXT7_API_KEY` 是可选回退；两者同时存在时配置文件优先。原生 MCP 在 Pi 中单独配置鉴权，不会自动复用此文件。

## 可选的原生 MCP 入口

1. 在选定的 Pi profile（agent 目录）中，按 Context7 的[当前安装说明](https://github.com/upstash/context7#installation)与 Pi 的 [MCP 指南](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/mcp.md)配置官方服务。个人凭据留在用户配置中。如已有同名服务的 URL、配置来源或认证拥有者不同，停止并确认；不要覆盖或把密钥搬入项目。
2. 核验连接，以及实际声明的 library 解析/文档查询工具名称与 schema。仅将这两个已核验工具设为 `direct`，未批准的工具保持隐藏。原生 MCP direct 不依赖 codemode；脚本能力可选，本包不启用 codemode/tool_search，也不修改 mode/defaultTools。
3. 验证成功后，用 `pi config` 在该 profile **仅停用旧 Context7 extension 入口**，保留 Skill。不要停用整个 bundle，也不要删除包、REST 配置或凭据。

也可编辑该 profile 设置中已有的 package 条目，保留版本固定与无关过滤项。独立安装排除 `extensions/context7.ts`；bundle 排除 `packages/pi-context7/extensions/context7.ts`。例如 bundle 的 package 条目可以是：

```json
{
  "source": "npm:@zhcsyncer/pi-extensions",
  "extensions": ["!packages/pi-context7/extensions/context7.ts"]
}
```

省略 `skills` 属性可保留包内 Skill。修改后执行 `/reload`。保持单一活动查询入口；如果仍看到两套工具，先检查是否还有显式加载的扩展，再查询。

回退时，在同一 profile 停用新 server、恢复旧 extension 入口并 reload，无需卸载包或删除凭据。这些是可选操作说明，不表示你的服务连接、工具或账号已核验。

## 许可证

MIT。详见 [`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md)、[`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE) 与 [`LICENSE`](./LICENSE)。
