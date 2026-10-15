# pi-fast-mode

## 为什么做

向**同一个模型**要更高调度优先级，不切模型或 thinking-level。只覆盖 Pi 1.2+ 当前主会话中的正常 Agent 请求；Consult、Recap 等扩展直接调用 SDK 的请求由各自负责，不为其增加拦截框架。

## 请求边界

`before_provider_request` 收到宿主已构造的 payload 后，按当前 `provider/id` 开关和固定支持范围决定是否覆盖 `service_tier`。开启且 payload 为非数组对象时，返回浅拷贝并写入 `priority`；关闭、不支持、没有模型或不是对象时不返回替换值，也不修改原对象。关闭并不保证请求为普通 tier：用户原本配置的 tier 必须保留。

支持 OpenAI / Codex 的 Responses 与 Codex Responses，以及 xAI Responses / 自定义 Completions。不写 `models.json`，不改认证、endpoint 或价格。扩展不注册 provider、不包装官方流、不维护预算配方；请求 options、采样、输出预算和响应解析都归宿主。这一边界避免复制 SDK 内部逻辑后随版本漂移。

Fast 只表达请求优先级，不保证提供商授予该 tier，也不自行调整本地费用。Pi 估算与实际 priority 费用可能有差异，以提供商账单为准。

## 状态与生命周期红线

- `/fast` 和 `Ctrl+F` 只改当前模型的内存开关，不写 session jsonl。快捷键保留重复保护，松开不再切换；成功切换只更新底栏。
- `/fast default on|off` 写当前模型的 `settings.json` 默认，并同步当前开关；不支持的模型拒绝操作。没有全模型默认，未配置的模型默认关。
- 切换模型读取该 `provider/id` 自己的开关，首次使用才读设置。`/new`、`/resume`、`/fork` 保留内存开关；`/reload` 或重启重读设置。
- 启动或 `/reload` 迁移旧的全局 `enabled` 和 boolean map 为开启名单。以前的全局开不能扩散到所有模型，且必须提示迁移影响。
- session 切换及关闭释放旧终端输入订阅和防重复计时器，避免重复响应。

## 验证边界

单元行为保护 payload 不变性、支持范围、按模型状态、设置迁移和快捷键；真实 Pi loader 验证扩展可加载且不替换 provider。主会话请求链的独立离线合同负责验证宿主实际接线；这些检查不替代真实账号、priority 授予或账单验证。
