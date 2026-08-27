# pi-fast-mode

状态：已落地

## 为什么做

向**同一个模型**要更高调度优先级。不是更快的模型变体，也不是 thinking-level。开关只活在当前进程；下次进程的默认值另写 `settings.json`。

## 红线

- `/fast` 和 `Ctrl+F` 只改内存开关，不写 session jsonl。松开 `Ctrl+F` 不再切换。
- `/fast default` 只写下次进程的默认值，不改当前开关。
- 提供商列表写死：OpenAI、Codex、xAI。没有用户白名单。
- Pi 0.84.3 的内置 xAI 模型已全部走 Responses。OpenAI、Codex 与内置 xAI 都通过 `registerProvider` 包官方 Responses 流；官方适配器负责序列化 `service_tier`，并按响应值调整本地费用：`priority` 通常约 2 倍，`default` 为 1 倍。
- `before_provider_request` payload 钩子只兜底 `models.json` 中自定义的 xAI Completions 模型，不得再改内置 xAI Responses 请求。
- 不能 `import @earendil-works/pi-ai/api/*`。Pi loader 把 `@earendil-works/pi-ai` 指到 `compat.js`，深路径加载即失败。Responses options 必须本地保留一份 `streamSimple` 收口；升级 Pi 后对照原厂配方，只有原厂加了新字段才改本地副本。
