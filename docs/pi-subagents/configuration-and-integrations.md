# pi-subagents 配置与集成约定

本文承接包 README 移出的配置位置与集成边界。用户入口见 [English README](../../packages/pi-subagents/README.md) / [中文 README](../../packages/pi-subagents/README.zh-CN.md)。投递和恢复见 [delivery-and-resume.md](./delivery-and-resume.md)。

## 配置位置与授权

- 全局默认：`$PI_CODING_AGENT_DIR/extension-data/pi-subagents/config.json`。
- 项目覆盖：`<cwd>/<CONFIG_DIR_NAME>/extension-data/pi-subagents/config.json`，通常为 `<cwd>/.pi/extension-data/pi-subagents/config.json`。
- `/agents → Settings` 只写项目文件；全局配置由用户手工编辑。
- 可选 `agent-tool-description.md` 与对应 `config.json` 同目录，项目内容优先；模板见 [examples/agent-tool-description.md](../../packages/pi-subagents/examples/agent-tool-description.md)。Worktree 指导必须使用 `{{isolationGuideline}}`，不要硬编码，以便禁用能力时 schema 和说明一起消失。

项目字段通常覆盖全局字段，但不能自行授权观察者：`pinnedExtensions` 只有全局配置可以增加名称，项目只能继承或用 `[]` 清空。非空项目列表被忽略并告警，Settings 因此只提供 inherit / clear。

```json
{
  "pinnedExtensions": ["pi-meter"]
}
```

名字大小写不敏感，匹配扩展目录/文件与无 scope 的包短名（`@zhcsyncer/pi-meter` → `pi-meter`）；全局 pin 在当前项目未安装时静默跳过。Pin 保证加载，不授予工具；只授权可信观察者，因为 handlers 仍能影响子会话，并非沙箱。设计理由见 [pinned-extensions.md](./pinned-extensions.md)。

## 默认值与迁移边界

`rememberAgents: true`、`worktreeIsolation: false`。关闭 worktree 能力时，所有来源的 worktree 请求都在真实 checkout 执行；开启后的实际创建失败必须报错。开关对运行时降级立即生效，对工具 schema/说明在下一次 Pi session 生效。Agent frontmatter 的 `isolation: off` 是 veto，其优先级高于 invocation。

旧全局/项目 `subagents.json` 和 `agent-tool-description.md` 仅作为一次性迁移输入。新位置始终优先；旧文件只有迁移写入并验证后才可删除。损坏、不可读或冲突时保留旧文件并告警，禁止覆盖新配置。通用路径及原子迁移规则见 [extension-data-layout.md](../extension-data-layout.md)。

本布局只覆盖运行设置和工具描述 override，不搬动 custom agents、Pi/native skills、Pi `settings.json`、memory、schedules、Pi sessions、worktrees 或 `.output` transcripts。Provider 凭证继续使用 Pi `auth.json`，不复制到恢复配置中。

## 进程内 spawn protocol v3

这里的 RPC 是扩展间通过 `pi.events` 通信，不是网络服务。`subagents:rpc:spawn` 的可选能力：

- `inlineAgentConfig`：使用调用方给出的角色 prompt/tools，不做 named-agent 查找或 fallback。
- `completionOwner: "caller"`：保留队列、停止、FleetView、生命周期事件与历史，但不发单 agent 主会话完成 nudge。要求 `isBackground: true` 与非空 `correlationId`。
- `correlationId`：started/terminal 事件原样返回编排方路由键。
- `graceTurns`：软 max-turn steer 后的收尾轮数；省略时使用全局默认五轮。

`subagents:rpc:ping` 返回 protocol version `3` 和 `maxConcurrent`。关联后的 terminal 事件含 requested/effective model 和 thinking；inline 角色开启持久化时还提供 `sessionFile`。省略这些可选字段保留 named-agent 路径和 detached `followUp` 投递，不变成手动 Agent-tool 的 `steer`。

调用方收口不是“不留历史”：完整扩展与 embedded runtime 都保留父会话终态 archive，并通过生命周期数据向编排方提供 child session 路径；恢复资格仍遵守当前分支、终态与 recipe 契约。

## 不激活扩展的运行时复用

依赖包可以导入 `@zhcsyncer/pi-subagents/runtime` 复用执行语义。单独 import 不注册 Agent 工具、命令、调度、widget 或 FleetView；构造与释放由调用方负责。这样编排包可以拥有自己的 UI 和汇总时机，而不加载第二套全局工具。

## 展示语义

TUI 预览不替代模型报告。紧凑 lifetime 计量保留 `input + output + cache write`，cache read 在 Usage 明细中单列，current context 是当前窗口占用；避免把历史总量和当前容量混成一个数（[上游 issue #38](https://github.com/tintinweb/pi-subagents/issues/38)）。未知阶段用 `working…` 而非宣称模型正在 thinking；粗阶段稳定后才展示，精确工具步骤留在 conversation overlay。
