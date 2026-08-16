# pi-meter 扩展方案

## 实现状态

已实现（第一期，包 `@zhcsyncer/pi-meter`，尚未走 version PR / 发版）。

落地边界：

- 两套账分开：`message_end` → `extension-data/pi-meter/usage.jsonl`；订阅快照单独在 `quota.json`。远端额度不进账本，也不进本地 budget。
- 常驻 chrome：一段 footer `setStatus`。左边本地用量，右边套餐窗口。
- `/usage` 管本地账；`/quota` 管套餐剩余；`/analytics` 只是 `/usage` 别名。
- 套餐条极性可切；颜色按剩余（约 30% / 15%）。token 条默认真量/费用，`/analytics details` 才露出 in / out / cache hit。
- 订阅刷新只在 `hasUI` 根会话的 `agent_settled` / `/quota` / `model_select`；TTL 60s + 最小间隔 30s。无 UI 进程只记本地账。
- SuperGrok：`GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` + `/login xai`。不打 `api.x.ai/v1/api-key`，不接 grok.com gRPC。
- 文档写明与 `@pi-plugins/usage` 互斥；若检测到对方占用 `/usage` 会警告一次。

本机已安装、仅作对照的第三方包：

- `npm:pi-tracker@0.3.0`：本地 token/费用账本 + `/analytics` / `/budget`
- `npm:@pi-plugins/usage@0.3.1`：Claude / Codex 订阅剩余 + `/usage`

二者不要同时和本扩展抢 `/usage`。

## 目标定位

做一个本地扩展，回答两件用户能直接感知的事：

1. **套餐还剩多少**（远端订阅窗口）
2. **已经烧掉多少、花在哪**（本地账本，按 provider / model / 项目拆开，含 in / out / cache）

不是「把两个现成包缝在一起」。产品名是仪表，不是拼接名。

- 包名：`@zhcsyncer/pi-meter`
- 一句话：本地用量账本，加上订阅剩余。`--no-session` 和默认 sub-agent 也会即时落盘；`/usage` 看套餐，`/analytics` 看花在哪。

## 为何两套账，不合成一本

远端剩余和本地累加测的不是同一件事。

| 面 | 问的问题 | 数据从哪来 | 丢不丢 |
|---|---|---|---|
| 套餐 | 这个订阅窗口还剩百分之几、何时重置 | 各家订阅 API，轮询快照 | 不进本地账本 |
| 账本 | 这次调用花了多少 token / 钱 | Pi `message_end` 的 `usage`，追加写盘 | 不依赖 session 文件 |

否决把 Claude 5h/周百分比、SuperGrok 周池、xAI 预付余额写进现有 `budgets.json`。本地 budget 继续只约束本地累加（费用 / tot / in / out，后续可加 cache）。远端告警若要做，另开 quota watch，不共用同一条上限。

## 用户能感知的行为

- `/usage`：Claude、Codex、SuperGrok 的窗口百分比和重置时间；可强制刷新快照。
- 常驻 chrome 与 Glance **完全独立**：不改 Glance、不占用其右下角、不改其顶栏 Tokens。Glance 在场时，meter 是输入框外多出来的一行。
- 套餐条极性可选「已用」或「剩余」；token 条可关细节（input / output / cache hit）。
- `/analytics`：本地看板。维度仍是 model / project / session；列能看到 tokens 拆分，不只是一坨 `totalTokens`。
- `/budget`：本地上限提醒，不拦请求。预算警告可以闪一下，不占常驻条。
- `--no-session`、默认内存 sub-agent：只要扩展加载进该进程，用量进独立账本。
- 旧 session 可选 `/analytics import` 回填；装好之后的新用量不靠 import。

## 常驻 TUI：caption 行 + 短套餐条

不改 Glance，不读 Glance 配置，不往 Glance 右下角塞东西。Glance 的 context 条和顶栏 Tokens 继续只讲 session/context；meter 讲订阅窗口和本地账本。

常驻面改走一段 footer `setStatus`（key `pi-meter`），不占 widget 整行。窗口语义写在数字前面：`today` 是本地今天花费，`week left` / `5h left` 是当前订阅窗口。

```text
· today 12.4k $0.18 · week left ███░░ 49% (1d 23h)
```

窄了先丢掉 token 细节，再丢掉总量/费用，最后留套餐条 + 百分比。

## 套餐条极性与高亮

远端快照只存**已用百分比**和重置时间。展示极性是本地偏好：

- **已用**：数字变大、条子变长 = 窗口消耗更多
- **剩余**：数字变小、条子变短 = 窗口还剩更少

颜色锚在「还剩多少」，不要两套阈值：剩得多用 muted/普通色，剩余降到约 30% warning（amber），约 15% error（软红）。已用模式只是把同一根条反过来读。

SuperGrok 本机已验证的主窗口是周池 `creditUsagePercent`。Build / Chat 是同一周池的产品拆分，不单独展示。

## 心智模型

```text
订阅 API
  ──► 至多一个 hasUI 进程，且快照过期才拉
  ──► extension-data/pi-meter/quota.json（共享快照）
  ──► 所有 session / sub-agent 只读
        ──► 常驻套餐条 + /usage

message_end
  ──► 本地账本 JSONL（每个进程自己追加）
  ──► token 条 /analytics /budget

session JSONL 只用于一次性回填。
```

模块按变更边界拆，不按代码像不像拆：

- **账本**：捕获、落盘、聚合、本地 budget、token 条。变更原因是「Pi 报了一次 usage」。
- **套餐**：各 provider adapter + 共享快照 + `/usage`。变更原因是「那家订阅 API 又改了」。
- **chrome**：套餐条 + token 条怎么画、极性、详略。变更原因是「人怎么扫一眼」，不碰拉接口。
- SuperGrok / Claude / Codex 各是独立 adapter。一家挂了只让那一节失败，不拖垮另外两家，也不拖垮本地记账。

## 订阅快照：落定时拉，再加最小间隔

默认 sub-agent **会加载扩展**（`extensions: true`），所以「加载了就会跑」是真的。不能靠「子代理不会执行」省请求，要靠门槛。

已拍板：不轮询。只在这些时刻检查要不要拉：

- `agent_settled`（这一轮真正结束）
- `/usage`（显式 refresh 可绕过 TTL）
- `model_select`（换到另一家订阅模型）

还要同时满足：

1. `ctx.hasUI === true`（根交互会话）。子代理进程、print、无 UI 的 `--no-session` **只读快照，不打接口**。它们照样记本地账本。
2. 共享文件 `$PI_CODING_AGENT_DIR/extension-data/pi-meter/quota.json` 已过期（默认 60s）。
3. **最小间隔**：同一 provider 距上次**成功或失败**的请求不足间隔（默认 30s）则跳过。防止 settled 连发、两个 UI 同时过期、或 refresh 连按。

写文件原子替换。两个 UI 都过期时允许短暂双拉，不引入跨进程锁。快照缺失或过期：显示上次数字并标 stale，或 `—`，不为填空再打。

本地账本仍是每进程 `message_end` 自己追加。那是本地盘，不是远端配额。

## 红线

- 不把远端额度写入本地 `usage.jsonl`。
- 不把远端额度塞进现有 budget 语义。
- SuperGrok 只走 Grok CLI 账单 JSON，不把 `api.x.ai/v1/api-key` 预付余额当成订阅。
- 第一期不接 grok.com `GetGrokCreditsConfig`（非官方 gRPC-web，还可能要浏览器 WKE）。
- 鉴权只用 Pi 已有的 `/login` OAuth，不再要求用户跑 `grok login` 或另存 cookie。
- 命令与输出不打印 token、邮箱、user id。
- 子代理 `isolated: true` / `extensions: false` / 排除本扩展时记不到——这是加载边界，不假装全覆盖。
- 安装后用户需关掉 `@pi-plugins/usage`，避免两个 `/usage`。
- 非 UI 进程不打订阅 API。
- 常驻套餐条不走 `setStatus`。

## 已验证的外部事实（2026-08-15，本机 `/login xai` OAuth）

Pi 内置 xAI device-code 的 scope 含 `grok-cli:access`。当前 access token（未过期）实测：

- `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` → 200。只带 `Authorization: Bearer` 即可；`x-xai-token-auth`、`x-userid` 不是必需。
- 响应有 `config.currentPeriod.type = USAGE_PERIOD_TYPE_WEEKLY`、`config.creditUsagePercent`、周期起止 ISO、`productUsage[]`（本机见到 `GrokBuild` / `GrokChat` 各带 `usagePercent`）。
- `GET https://cli-chat-proxy.grok.com/v1/billing`（无 `format=credits`）→ 另一份月度 used/limit 形状；本机这次没有可用的 monthly used/limit 对比。
- `GET https://api.x.ai/v1/api-key` → 401。订阅 token 不是 API 预付金。
- grok.com gRPC-web 也回了 200，但账单 JSON 已够画 `/usage`，第一期不用它。

Claude / Codex 仍走 `@pi-plugins/usage` 现有官方订阅接口，本方案不重新发明。

## 范围

做：

- 新包 `@zhcsyncer/pi-meter`，同时提供套餐面和账本面。
- SuperGrok 作为 `/usage` 第三家供应商。
- 共享订阅快照；UI 根会话才刷新。
- 常驻 chrome：输入框下一行 caption + 短套餐条，与 Glance 独立；极性已用/剩余可切；token 条可关细节。
- 订阅刷新：仅 hasUI 根会话在 settled / `/usage` / 切模型时拉；共享快照 + 最小间隔。
- 看板补齐 in / out / cache 拆分。
- 配置与快照落在 `$PI_CODING_AGENT_DIR/extension-data/pi-meter/`。若沿用 `analytics/usage.jsonl`，要自动迁到该目录。

不做（第一期）：

- 用远端剩余驱动现有 budget，或硬拦请求。
- SuperGrok 网页周池 / 浏览器 cookie。
- isolated 子代理的旁路记账。
- 把 compaction / `tool_result.usage` 补进账本（知道会漏，不假装已覆盖）。
- 独立跨进程 daemon。共享文件 + hasUI 写者够用。
- 改 Glance，或把 meter 画进 Glance 输入框内部。

## 验收

1. `--no-session` 跑一轮后，独立账本有对应 assistant 记录；关掉 session 文件也不丢。
2. 默认（非 isolated）sub-agent 的用量进同一本账，能按 model 看到。
3. `/analytics` 能读出 input / output / cache read / cache write，不是只有 total。
4. 已 `/login xai` 时，`/usage` 能显示 SuperGrok 当前窗口百分比和重置时间。
5. 常驻套餐条不依赖 Glance；切已用/剩余时，数字（和若有的条子）一起反转。
6. token 条默认紧凑；打开细节后能看到 input / output / cache hit。
7. 两个并行 UI session 在 TTL 内不会各自打订阅 API；无 UI 的 sub-agent 进程不打。
8. Claude 或 Codex 接口失败时，另外两家和本地记账仍可用。
9. 不与仍启用的 `@pi-plugins/usage` 双注册 `/usage`——文档写明互斥；若能检测重复则警告。
