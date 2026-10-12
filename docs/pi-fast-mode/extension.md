# pi-fast-mode

状态：现有架构；Pi 1.1 options 适配待独立组合验收

## 为什么做

向**同一个模型**要更高调度优先级。不是更快的模型变体，也不是 thinking-level。每个模型的开关只活在当前进程；下次进程的默认按模型另写 `settings.json`。没配过的模型默认关，因为 Fast 按次计费。

## 红线

- `/fast` 和 `Ctrl+F` 只改当前模型的内存开关，不写 session jsonl。松开 `Ctrl+F` 不再切换。
- `/fast default` 写当前模型的下次默认，并且当前这次会话的开关跟着改。不支持 Fast 的模型直接失败。没有「所有模型」默认。启动或 `/reload` 时迁移旧的全局 `enabled` 和 boolean map，写成开启名单；以前的全局开不会扩散到所有模型，并必须 notify。
- 换模型使用该模型自己的内存开关；第一次用到时从设置读取，没配过就是关。`/new` `/resume` `/fork` 保留各模型内存开关；`/reload` 或重启才重读设置。
- 提供商列表写死：OpenAI、Codex、xAI。没有用户白名单。
- 需要 Pi 1.1+，不维护旧宿主分支。内置 xAI 走 Responses。OpenAI、Codex 与内置 xAI 都通过 `registerProvider` 包官方 Responses 流；官方适配器负责序列化 `service_tier`，并按响应值调整本地费用：`priority` 通常约 2 倍，`default` 为 1 倍。不切模型、认证或计费渠道。
- `before_provider_request` payload 钩子只兜底 `models.json` 中自定义的 xAI Completions 模型，不得再改内置 xAI Responses 请求。
- Pi 1.1 的真实 `DefaultResourceLoader` 仍将 `api/simple-options` 与 `utils/estimate` 错映射到 `compat.js/...`；compat 没有导出这两个 helper。不能用绝对安装路径绕过宿主加载。只保留一份薄预算配方，并复用 loader-safe 的 `getSystemMessageText`；未来公开 helper 可安全加载时优先删除本地配方，而非添加双版本分支。
- Options 整体透传，不能用字段白名单丢掉 hook（尤其 `onProviderStreamEvent`）或认证附带信息。模型和思考档默认值不得提前写入请求 `samplingParams`；OpenAI/xAI Responses 官方 adapter 在序列化时执行「模型默认 < 有效思考档默认 < 请求显式采样」。缺省 reasoning 表达 off，档位先按模型能力 clamp；显式 undefined 按官方对象合并/JSON 省略语义处理。Codex 保持其官方序列化，不为其补写 SDK 本来忽略的任意采样字段。
- 预算只读取规范化 transcript：可靠 assistant usage 覆盖此前前缀，只估算其后消息；取消、错误或早于前缀时间戳的 usage 不作新基准。按 3.5 字符/token、4096 安全余量与官方最小输出限制计算；系统正文/sections、工具增删及图片计入同一配方，不另发 tokenizer 请求。
- 维护用例必须对照实际安装 SDK 的预算和离线 wire payload，而不是本地实现互相证明。真实 loader 测试同时保护 helper 不可用的外部约束与 Fast 三条 Responses 接线；该离线证据不代替独立合同组合、真实账号或其他打包宿主验收。
