# Volcengine Agent Plan 扩展 · 多 API Key 与 5h 额度耗尽自动轮换方案

> 当前实现：[`../index.ts`](../index.ts)（独立 npm 子包的单文件扩展入口）。
> 本文档仅描述尚未实现的可选增量方案，不代表当前已发布能力。
> 与 [`quota-auto-refresh-design.md`](./quota-auto-refresh-design.md) 互补：本文档不依赖 AK/SK，
> 配额耗尽信号来自推理请求的报错（反应式），而非管控面主动查询（前瞻式）。

## 1. 目标

1. 一个 provider 可配置**多个 Agent Plan API Key**（典型场景：多个账号各买一份套餐；
   同一账号的多个 key 共享套餐额度，轮换无意义，文档中需说明）。
2. 推理请求因某个 key 的 **5 小时 AFP 窗口额度耗尽**而失败时，**自动切换到下一个 key** 重发请求，
   用户无感（仅一次 pi 会话层自动重试，约 2s）。
3. 提供 `/ark-plan-keys` 命令查看 key 池状态、手动轮换、清除耗尽标记。
4. 单 key 用户的现有行为（login、env、`auth.json` 格式）**完全兼容，零迁移**。

非目标（本期不做）：

- per-key tier（各账号套餐档位不同时的模型过滤联动；依赖 quota 设计文档的 tier 自动刷新，留作后续）；
- AK/SK + `GetAFPUsage` 的前瞻式轮换（需每个账号各配一套 AK/SK，接入负担重）；
- 新增复数环境变量（评审结论：不需要，key 统一走 login 录入存 `auth.json`）。

## 2. 机制调研结论（已读 pi / pi-ai 源码验证）

以下事实决定方案选型，均来自对当前依赖版本（`@earendil-works/pi-coding-agent` 0.82.1、
`@earendil-works/pi-ai`）源码的直接阅读：

### 2.1 `auth.apiKey.resolve()` 每次 LLM 请求都会重新执行，无缓存

调用链：`ModelRuntime.streamSimple()` → `prepareRequest()` → `Models.getAuth()` →
`resolveProviderAuth()` → 本扩展的 `resolve()`（`pi-ai/dist/auth/resolve.js`）。
**扩展可以在 resolve 时动态决定返回哪个 key**——这是本方案的核心支点。
所有鉴权路径（`auth.json` 存储、models.json 配置、环境变量）最终都汇入扩展的 `resolve()`
（`pi-coding-agent/dist/core/provider-composer.js` 的 `composeApiKeyAuth` 在有 `inherited` 时一律委托）。

### 2.2 pi 的会话层自动重试会重新 resolve 鉴权

两层重试（`pi-ai/dist/utils/provider-retry.js`、`pi-coding-agent/dist/core/agent-session.js`）：

| 层 | 触发 | 默认 | 是否换 key |
| --- | --- | --- | --- |
| 传输层 `retryProviderRequest` | 429/5xx/网络错误 | `maxRetries=0`（用户未配 `retry.provider.maxRetries` 时等于关闭） | 否（同一份 options/apiKey） |
| 会话层 `_prepareRetry` | 最终 assistant 消息为可重试错误 | 开启，`maxRetries=3`，`baseDelayMs=2000`（2s/4s/8s） | **是**（重跑 streamFn → 重新 `prepareRequest` → 重新 `resolve()`） |

因此：检测到额度耗尽 → 标记当前 key → pi 会话层重试时 `resolve()` 返回下一个 key，即完成切换。

### 2.3 重试判定可被扩展"引导"

`isRetryableAssistantError`（`pi-ai/dist/utils/retry.js`）：

- 命中不可重试词（`quota exceeded`、`insufficient_quota`、`out of budget`、`billing` 等）→ **不重试**；
- 命中可重试词（`429`、`rate limit`、`too many requests` 等）→ 重试。

`message_end` 扩展钩子可以返回替换消息，且替换发生在 pi 重试判定**之前**
（`agent-session.js`：先 `_emitExtensionEvent`（原地替换），后记录 `_lastAssistantMessage`，
`agent_end` 后才做 `_isRetryableError` 检查，与 context-overflow 文档所述机制相同）。
所以扩展可以在确认已轮换到不同 key 时**改写 `errorMessage`，确保 pi 必定重试**。

### 2.4 `after_provider_response` 对本 provider 检测不了 429

openai-responses / openai-completions 两个内置 API 中，`onResponse` 只在请求**成功**（2xx）后调用；
429 时 SDK 抛错直接进入 error 分支。因此额度检测点只能是 `message_end`，此时
`errorMessage` 形如（responses API）：

```
OpenAI API error (429): {"error":{"code":"...","message":"..."}}
```

completions API 无前缀，直接是状态码+错误体。两者都包含完整上游错误文本，可做模式匹配。

### 2.5 凭证存储天然兼容多 key

`ApiKeyCredential = { type, key?, env? }`，一个 provider 一份 credential。
`auth.json` 读取时 `key` 会经过 `resolveConfigValue`（`auth-storage.js`），
支持 `$ENV_VAR` / `!command` **整值**插值——因此 `key` 存逗号拼接的多 key 不受影响，
甚至用户手工在 `auth.json` 里写 `"$MY_KEYS"`（其值为逗号拼接）也能工作。
pi 本体除存取外不消费 `credential.key` 的内容（状态展示只显示 source 标签）。

## 3. 火山方舟侧事实与未知项

已知：

- 5 小时 AFP 窗口按首次请求时间滚动刷新；额度耗尽后（未开"超额后付费"）请求失败，等待窗口重置。
- 开启"超额后付费"的账号额度耗尽后**不报错**、静默走按量计费，轮换逻辑不会触发（属预期）。
- 同类报错为 HTTP 429；已观测到的 429 样本 `ServerOverloaded` 属**临时过载**，必须与额度耗尽区分。
- 额度为账号级：多 key 场景即多账号，各账号 tier 可能不同（本期按单一 tier 处理，见 §8）。

未知（需实测校准，见 §7 验证计划）：

- **额度耗尽时的确切错误码/错误文本**（官方错误码文档为动态渲染，公开渠道未确认；
  匹配正则按"429 + 额度关键词、排除 ServerOverloaded"设计，收敛为单常量，实测后校准）；
- 错误文本中是否携带窗口重置时间（若有则解析之，替代 +5h 的保守估计）。

## 4. 方案对比与选型

| | A. resolve 动态选 key + message_end 反应式标记（**选定**） | B. 自定义 streamSimple 流内换 key | C. AK/SK 主动查询预判 |
| --- | --- | --- | --- |
| 原理 | resolve 返回第一个未耗尽 key；message_end 识别额度错误 → 标记耗尽 + 改写 errorMessage → pi 自动带新 key 重试 | 包装两个 API 的 streamSimple，流内捕获 429 → 换 key 重发，对 pi 透明 | 每账号配 AK/SK，`GetAFPUsage` 精确预判 |
| 切换延迟 | 一次 ~2s 自动重试 | 几乎无感 | 0（发送前即切） |
| 检测可靠性 | 依赖错误文本模式匹配 | 直接读 status+body，最可靠 | 最精确（含 ResetTime） |
| 实现复杂度 | 低（扩展事件 + 状态文件） | 高（事件转发 / abort / usage 需重新处理） | 高且接入负担重 |
| 与 pi 机制冲突 | 无（完全复用既有重试） | 与 pi 重试预算叠加，需小心 | 无 |

选 A；若实测发现错误文本无法稳定区分"额度耗尽"与"临时限流"，再升级到 B。

## 5. 改造设计

### 5.1 模块拆分

```
providers/pi-provider-volcengine-agent-plan/
├── index.ts            # provider 注册、login、扩展事件（message_end / 命令 / status）
├── key-pool.ts         # key 解析、选择、指纹、耗尽判定正则（纯函数，无 IO，可单测）
└── key-state-store.ts  # 耗尽状态持久化（agentDir 文件 + mtime 缓存）
```

`package.json` 的 `pi.extensions` 继续只注册 `./index.ts`。

### 5.2 多 key 的存储与 login 流程

存储：`credential.key = keys.join(",")`（逗号拼接；单 key 无逗号，天然兼容现有 `auth.json`）。
`resolveConfigValue` 的 `$ENV`/`!command` 整值插值在读取时先于我们的 split 执行，不受影响。

login 流程（`auth.apiKey.login`）：

```
1. 循环（n 从 1 起）：
   a. prompt secret：Agent Plan API Key #n → validateAgentPlanKey 逐个验证（沿用现有逻辑）
   b. select："已保存 n 个 key，继续添加下一个？"（完成 / 继续添加）
2. select tier（同现状，单 tier 适用于全部 key，UI 注明建议同档位账号）
3. 存 credential：{ type: "api_key", key: keys.join(","), env: { TIER_ENV: tier } }
```

环境变量路径（未 login 时）保持现状单 key（`KEY_ENV_NAMES`），不新增复数变量；
若用户只在 env 配了一个 key，行为与今天完全一致。

### 5.3 key 池解析与选择（key-pool.ts）

```ts
parseKeyPool(raw: string | undefined): string[]        // 逗号分隔、trim、去重、保序
keyFingerprint(key: string): string                    // sha256 hex 前 12 位，状态文件与日志均不用明文
maskKey(key: string): string                           // "…" + 后 4 位，用于命令/通知展示
```

选择策略（`resolve()` 内）：**第一个未耗尽 key**（按配置序）。

- 天然粘性：只有当前 key 被标记耗尽后才换下一个，无需持久化"active index"，重启后由耗尽状态自然推导；
- 全部耗尽：返回 `exhaustedUntil` 最早的 key（探测性请求，窗口一恢复即自动成功）；
- 单 key：行为与现状完全一致。

`resolve()` 返回的 `source`：多 key 时为 `"Pi auth.json (key 2/3)"`，单 key 保持 `"Pi auth.json"`。

`check()` 不变（池内 ≥1 个 key 即视为已配置）。

### 5.4 耗尽检测（index.ts 的 message_end 钩子）

触发条件（全部满足）：

- assistant 消息、`stopReason === "error"`；
- `message.provider === PROVIDER_ID`（兜底 `ctx.model?.provider`）；
- `errorMessage` 含 `429`；
- 命中**额度关键词**（`QUOTA_EXHAUSTED_PATTERN`：`/额度|套餐|quota|subscription|AFP/i` 等，单常量，实测校准）；
- **不**命中**临时过载词**（`TRANSIENT_429_PATTERN`：`/ServerOverloaded|overloaded/i`）。

命中时对"最近一次 resolve 返回的 key"（模块级 `lastResolvedFingerprint` 记录）打耗尽标记。
并发场景（主 agent 与子任务同时请求）理论上可能错标，本 provider 下并发少、代价仅为多标一个
key 进入冷却，可接受。

不命中时什么都不做（临时限流/过载交给 pi 既有重试，原 key 短期内自愈）。

### 5.5 耗尽标记与自愈（key-state-store.ts）

状态文件 `<agentDir>/volcengine-agent-plan-keys.json`
（`<agentDir>` = `process.env.PI_CODING_AGENT_DIR ?? ~/.pi/agent`，与 quota 设计文档一致）：

```jsonc
{
  "version": 1,
  "keys": {
    // sha256 指纹 → 标记
    "ab12cd34ef56": { "exhaustedUntil": 1778806800000, "markedAt": 1778788800000, "lastError": "429 …（截断）" }
  }
}
```

读写策略沿用 quota 设计文档：模块级内存缓存 + mtime 检查；写文件后同步更新内存；跨进程共享。

标记规则：

| 情形 | `exhaustedUntil` |
| --- | --- |
| 首次标记（无未过期标记） | `now + 5h`（窗口长度上限，保守） |
| 再次标记（已有标记但已过期，即探测失败） | `now + 30min`（探测冷却，避免每次探测都把恢复时间推满 5h） |
| 请求成功（`message_end` 非 error 且 provider 匹配） | 清除 `lastResolvedFingerprint` 的标记（若存在）——窗口实际重置早于保守估计时自校正 |

写入时清理：不属于当前 key 池的指纹条目（用户换过 key）一并丢弃。

### 5.6 重试引导（改写 errorMessage）

**仅当**标记后池中仍存在其他可用 key（即下一次 `resolve()` 会返回不同的 key）时，
`message_end` 返回替换消息：

```
errorMessage:
429 rate limit: Agent Plan key 1/3 的 5h 额度已耗尽，已自动切换至 key 2/3 并重试。
原始错误：<脱敏截断 200 字符>
```

- 必须含 `429` / `rate limit`（命中可重试词）；
- 嵌入的原始错误先做**不可重试词清洗**（`quota exceeded`→`quota hit`、`insufficient_quota`→
  `insufficient-quota`、`billing`→`bill-ing`、`out of budget`→`over budget`），
  防止 `isRetryableAssistantError` 的不可重试分支抢先命中；
- 无其他可用 key（全部耗尽）时**不改写**，走 pi 对 429 的默认重试/报错路径；
- 用户关闭 `retry.enabled` 时不重试，但改写后的文案已明确告知"已切换"，下一条消息自动用新 key。

### 5.7 UX：通知、status 与 `/ark-plan-keys` 命令

- 轮换发生时 `ctx.ui.notify`：`Agent Plan key 1/3 额度耗尽，已切换至 key 2/3`；
- status（`ctx.ui.setStatus("volcengine-agent-plan", …)`，仅当前模型属本 provider 时）：
  `Ark Medium · key 2/3`；与 quota 设计文档的 status 文案合并点（`Ark Large · 5h 25% · key 2/3`）
  在该方案落地时统一，本期只做 `key i/n` 部分；
- `/ark-plan-keys` 命令：
  - 无参：列出池状态（序号、掩码、是否当前 active、耗尽剩余时间、来源）；
  - `rotate`：给当前 active key 打一个 10 分钟短冷却标记 → 立即切到下一个（手动轮换）；
  - `clear`：清除全部耗尽标记（用户确认额度已刷新后用）。

### 5.8 不改动清单

- CATALOG 与 `minimumTier` 过滤逻辑（单 tier）；
- `before_provider_request` 中 minimax-m2.7 / kimi-k2.6 的 thinking hack；
- 既有环境变量（`ARK_AGENT_PLAN_TIER`、`KEY_ENV_NAMES`）读取分支；
- baseUrl、两种 API（responses/completions）注册方式、`validateAgentPlanKey`。

## 6. 与 quota-auto-refresh-design.md 的关系

- 两套方案共享 `<agentDir>` 文件存储与 mtime 缓存模式，但状态文件不同（`…-cache.json` vs `…-keys.json`）；
- quota 方案的 tier 自动刷新落地后，可演进为 per-key tier：key 池解析时按 active key
  取对应账号缓存的 tier，`filterModels` 按 active key 过滤（需配合模型列表刷新，届时另行设计）；
- quota 方案的 `GetAFPUsage` 数据（精确 `ResetTime`）未来可用于替换 §5.5 的 `+5h` 保守估计
  （仅当用户配置了对应账号的 AK/SK 时）。

## 7. 验证计划

1. **错误文本实测校准**（关键）：用一个真实 key 打满 5h 额度（或找一份现成报错日志），
   确认错误码/文本，校准 `QUOTA_EXHAUSTED_PATTERN` / `TRANSIENT_429_PATTERN`；
   顺带确认错误文本是否含重置时间（若有，解析替代 +5h）。
2. **单元测试**（沿用 `test/provider.test.ts` 的 jiti + `node:test` 方式）：
   - `parseKeyPool`：单 key / 逗号拼接 / 空白 / 去重；
   - login：循环录入 2 个 key（第二次选"完成"），credential.key 为拼接结果；
   - resolve 选择：未标记时返回第一个；标记 key1 后返回 key2；全部标记时返回最早恢复者；
   - 标记规则：首次 +5h、再犯 +30min、成功清除；
   - message_end：命中额度错误时改写 errorMessage（含 429、不含不可重试词）、
     无其他 key 时不改写、`ServerOverloaded` 不标记、非本 provider 不处理；
   - 状态文件：mtime 缓存读取、跨进程写入后可见、换 key 后旧指纹被清理。
3. **加载冒烟**：`pi --no-extensions -e ./providers/pi-provider-volcengine-agent-plan --list-models volcengine-agent-plan`
   （沿用 `scripts/check-smoke.mjs`，`PI_CODING_AGENT_DIR` 指向临时目录）。
4. **端到端**：两个真实 key（或一个耗尽 key + 一个有效 key）登录后，触发一次额度错误，
   观察 notify、status、`/ark-plan-keys` 输出与自动重试成功。

## 8. 风险与备注

- **真实错误文本未知**：正则可能漏判（不轮换，退化为现状）或误判（把临时 429 当耗尽）。
  缓解：正则单常量 + 测试 + `/ark-plan-keys clear` 手动兜底；实测后收敛。
- **多账号 tier 不一致**：本期 tier 为单配置；若 active 账号实际档位低于配置 tier，
  模型列表会出现该账号无权使用的模型（调用时 403/404）。文档注明"建议同档位账号"，
  per-key tier 留待 quota 方案联动。
- **超额后付费**：开启的账号不报错、直接走按量计费，轮换不触发——属预期，README 需提醒
  （不想产生按量费用的用户应关闭该开关）。
- **套餐条款**：多账号轮换属于用户个人的多订阅使用，需在 README 保持现有
  "非官方扩展、与火山引擎无关"的免责声明，并提示用户自行确认套餐使用条款。
- **并发误标**：主 agent 与子任务并发时 `lastResolvedFingerprint` 可能串，
  代价是误标一个 key 进入冷却（30min~5h 后自愈），可接受。
