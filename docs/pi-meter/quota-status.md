# pi-meter 套餐条与本地窗口口径

稳定决策。实现后只留这里的 Why / 行为契约；过程量不要再写进文档。

## 用户能看到的行为

底栏只画**当前模型对应的那一家**套餐。画不出来就短提示，绝不借别人的额度。

本地 token 统计默认按滚动窗口；可在 `/usage footer` 切回日历窗口。本地 budget 仍按自然日 / 周 / 月。

## 已拍板

### SuperGrok 缺百分比

`GET .../billing?format=credits` 能读到 `config`（通常还有 `currentPeriod`），但没有数字型 `creditUsagePercent` 时，当成 **已用 0% / 剩余 100%**，照常画周窗。

整段响应认不出 `config` 才算失败。不要再报 `missing creditUsagePercent`。

原因：周窗刚重置或用量为 0 时，接口会省略该字段；网页 usage 此时是 0%。

### 底栏不回退

先查已登记 guest 的 `matchProvider`，再查内置：`xai` → SuperGrok，`openai-codex` → Codex，`anthropic` → Claude，`ollama-cloud` → Ollama。只画这一家的 `primary`。未登记 guest 时行为与原来一致；没装 guest 的用户看不到 guest 标题。

拿不到时：

| 情况 | 底栏 |
|---|---|
| 当前模型没有订阅窗口（如本地 `ollama`） | `{provider} · no quota window` |
| 有窗口但没 `/login` | `{brand} · not signed in` |
| 已登录但这次没拉到 | `{brand} · unavailable` |

### 品牌

短小写，贴在窗口前面：

```text
· 24h 12.4k $0.18 · xai week left █████ 100% (6d)
· 24h 12.4k $0.18 · openai week left ██░░░ 10% (2d)
```

映射：`supergrok` → `xai`，`codex` → `openai`，`claude` → `claude`，`ollama` → `ollama`。不用 `supergrok` / `OpenAI Codex`。

### 未登录不打订阅接口

本地 `auth.json` 没有对应凭证时，不要调用那家订阅 API，也不要走 `getApiKeyForProvider`（以免误触发 refresh）。

看板底部仍汇总 `Not signed in: Claude — run /login`。`/login` 之后下一次 settled / refresh / 切模型再拉。

失败快照（`ok: false`）不算 fresh，不要用 TTL 把错误锁 60 秒。未登录快照不要用 `lastAttemptAt` 挡住登录后的第一次拉取。

### 本地账时间窗

配置 `ledger.windowMode`: `rolling` | `calendar`。默认 `rolling`。`/usage footer` 增加一行可切。

| key | rolling | calendar |
|---|---|---|
| today | 过去 24h | 今天 0 点起 |
| week | 过去 7d | 本周一 0 点起 |
| month | 过去 30d | 本月 1 日 0 点起 |
| 6months | 过去 180d | 过去 180d |
| year | 过去 365d | 今年 1 月 1 日 |
| all | 全部 | 全部 |

底栏本地摘要：rolling 写 `24h`，calendar 写 `today`。内部 preset key 仍是 `today-spend` 等，不要为改文案做迁移。

本地 budget 的 `day` / `week` / `month` / `year` **保持日历**，不跟 `windowMode` 走。

## 验收

1. SuperGrok 响应有 `config`、无 `creditUsagePercent` → 看板 / 底栏显示周窗 0% 已用（剩余 100%），带重置时间（若有 period end）。
2. 当前模型是 `xai`、SuperGrok 失败、Codex 成功 → 底栏是 `xai · unavailable`，没有 Codex 的 week 条。
3. 当前模型是 `xai`、SuperGrok 成功 → `xai week left …`。
4. 当前模型是本地 `ollama` → 仍是 `ollama · no quota window`。
5. 未 `/login` Claude 时，刷新循环不打 Anthropic；看板仍把 Claude 收在底部未登录提示。
6. 默认底栏本地数字是过去 24h，文案 `24h`；footer 切到 calendar 后变成当天 0 点起，文案 `today`。budget 数字不随该开关变。
7. 双语 README 示例与上述底栏一致。用户可见变更带 changeset（`@zhcsyncer/pi-meter` + 根包，根包级别不低于子包）。
