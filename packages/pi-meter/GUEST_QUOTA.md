# Guest quota adapter（给后续接入 agent）

不是用户文档。用户 README 只写「其他扩展可以登记配额源，footer 跟当前模型走」。

## 如何 register

优先：

```ts
import { registerQuotaAdapter } from "@zhcsyncer/pi-meter";

registerQuotaAdapter({
  id: "cursor",
  title: "Cursor",
  matchProvider: (modelProvider) => modelProvider === "cursor",
  fetch: async (ctx, fetchedAt) => { /* return QuotaSnapshot; do not throw */ },
});
```

Guest 可能比 meter 先加载。不要 import meter 内部路径。先加载时把 adapter 放进 mailbox；meter 启动会 drain。

```ts
const key = Symbol.for("@zhcsyncer/pi-meter/quota-adapters");
const host = globalThis[key];
if (typeof host?.register === "function") {
  host.register(adapter);
} else {
  const mailbox = Array.isArray(host?.mailbox) ? host.mailbox : [];
  mailbox.push(adapter);
  globalThis[key] = { ...host, mailbox };
}
```

同一 `id` 后注册覆盖先注册。`id` 不能是内置的 `claude` / `codex` / `supergrok` / `ollama`：直接拒绝。`matchProvider` 若命中 `anthropic` / `openai-codex` / `xai` / `ollama-cloud`，adapter 仍可登记，但这些匹配会被忽略。两种情况都会 `console.warn`，TUI 启动后再 `ui.notify` 一次。

## Symbol key

`Symbol.for("@zhcsyncer/pi-meter/quota-adapters")`

挂载对象提供 `register` / `list`。可选 `mailbox: unknown[]`，仅供 meter 尚未启动时暂存。

公开导出：`registerQuotaAdapter`、`listQuotaAdapters`、`QUOTA_ADAPTERS_KEY`、`QuotaAdapter`、`QuotaSnapshot`。

## Adapter 与 fetch 失败

| 字段 | 语义 |
|---|---|
| `id` | 稳定字符串，如 `"cursor"`。不要写进 `QuotaProviderId` 联合类型。 |
| `title` | footer / `/usage quota` 标题 |
| `matchProvider(modelProvider)` | 当前模型的 `model.provider` 是否归这家 |
| `fetch(ctx, fetchedAt?)` | 自己处理鉴权失败，返回 `{ ok: false, error }`。不要抛到 meter 外面。 |

`QuotaSnapshot.provider` 填自己的 `id`。刷新 / TTL / min-interval / stale 走 meter 现有 policy，和内置四家共用 `quota.json`。

## preferred / footer

1. `preferredProvider` 先锁定内置 `anthropic` / `openai-codex` / `xai` / `ollama-cloud`，guest 只能认领其余 `model.provider`。
2. Footer 只用这个 preferred。没有这家快照就 muted hint，绝不回落到另一家（例如 cursor 模型上画 SuperGrok）。
3. 没登记 guest 时，内置四家行为不变。未安装 guest 的用户看不到 guest 标题。
4. `/usage quota` 列出已登记 guest；未登录仍走现有 unsigned-in 汇总。

## 改过的关键文件

- `packages/pi-meter/index.ts` — 公开导出
- `packages/pi-meter/src/quota/guest.ts` — 注册表、mailbox、host
- `packages/pi-meter/src/quota/types.ts` — `QuotaSourceId`；store / snapshot 接受 guest 字符串 id
- `packages/pi-meter/src/quota/store.ts` — 读写 guest id
- `packages/pi-meter/src/quota/refresh.ts` — preferred 先锁定内置模型；refresh 包含已登记 guest
- `packages/pi-meter/src/quota/policy.ts` — chrome 只跟 preferred
- `packages/pi-meter/src/quota/auth.ts` — 未知 id 不当内置凭证
- `packages/pi-meter/extensions/meter.ts` — 启动 drain；quota 面板列出 guest
