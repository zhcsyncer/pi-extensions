# Volcengine Agent Plan 扩展 · 套餐余量与 tier 自动刷新方案

> 当前实现：[`../index.ts`](../index.ts)（独立 npm 子包的单文件扩展入口）。
> 本文档仅描述尚未实现的可选增量方案，不代表当前已发布能力。

## 1. 目标

在现有 provider 扩展上做到"配置一次"：

1. 推理照常使用 Agent Plan 专属 API Key（Bearer，数据面）。
2. 可选配置火山引擎 Access Key（AK/SK）后：
   - 通过管控面接口 `GetAFPUsage` **自动刷新当前订阅 tier**（替代登录时手动选择）；
   - 在 TUI 状态栏 / 命令中展示套餐余量（5 小时 / 日 / 周 / 月四个 AFP 窗口）。
3. 不配 AK/SK 时维持现状：tier 由用户在登录流程中手动提供。
4. **不新增任何环境变量分支**（避免额外逻辑分支）；既有环境变量行为保持不动。

## 2. 认证调研结论（为什么必须双凭证）

方舟 API 分数据面与管控面（[Base URL及鉴权](https://www.volcengine.com/docs/82379/1298459)）：

| 面 | 端点 | 鉴权 |
| --- | --- | --- |
| 数据面（推理：Chat/Responses 等） | `https://ark.cn-beijing.volces.com/api/v3`（Agent Plan 为 `/api/plan/v3`） | API Key（Bearer）或 AK/SK 签名 |
| 管控面（`GetAFPUsage`、接入点/API Key 管理等） | `https://ark.cn-beijing.volcengineapi.com/` | **仅 AK/SK HMAC-SHA256 签名** |

已排除的"单凭证"路线：

| 路线 | 结论 |
| --- | --- |
| Agent Plan API Key（Bearer）直调管控面 | ❌ 已实测：`ark.cn-beijing.volces.com` → 404；`ark.cn-beijing.volcengineapi.com` → `InvalidAuthorization` |
| 只用 AK/SK 签名调推理 | ❌ AK 鉴权时 `model` 必须是 `ep-xxx` 接入点 ID；Agent Plan 按模型名直调、无接入点概念，且不计入套餐额度 |
| AK/SK 调 `GetApiKey` 换临时 key 再推理 | ❌ [GetApiKey](https://www.volcengine.com/docs/82379/1262825) 产出的是**资源绑定临时 key**（`endpoint`/`bot`/`presetendpoint`），计费走接入点按量付费（`GetUsageDetails` 中的 `OutsideOfPlan`），不走套餐 |
| 管控面读回个人版 key 明文 | ❌ 无读回接口；仅 `RegeneratePersonalApiKey`（轮换，会使在用 key 立即失效，禁止使用） |

**结论：套餐额度只认"个人版 API Key"，余量查询只认 AK/SK，两者不可互替，必须双凭证。**

## 3. 依赖的管控面接口

### 3.1 GetAFPUsage —— 获取套餐 AFP 额度（核心）

文档：<https://docs.volcengine.com/docs/82379/2479847>

```http
POST /?Action=GetAFPUsage&Version=2024-01-01 HTTP/1.1
Host: ark.cn-beijing.volcengineapi.com
Content-Type: application/json; charset=UTF-8
X-Date: 20260511T034034Z
X-Content-Sha256: <hex>
Authorization: HMAC-SHA256 Credential=<AK>/<yyyymmdd>/cn-beijing/ark/request, SignedHeaders=host;x-content-sha256;x-date, Signature=<hex>

{}
```

无业务请求参数。响应 `Result`：

| 字段 | 说明 |
| --- | --- |
| `PlanType` | 套餐档位：`Small` / `Medium` / `Large` / `Max`（注意首字母大写，映射到扩展内部的小写 `PlanTier`） |
| `AFPFiveHour` / `AFPDaily` / `AFPWeekly` / `AFPMonthly` | 四个窗口，各含 `Quota`（总配额）、`Used`（已用）、`SubscribeTime`（窗口开始，epoch ms）、`ResetTime`（下次重置，epoch ms） |

签名参数固定：`Service: ark`、`Region: cn-beijing`。

### 3.2 签名算法要点（火山 v4，类 AWS SigV4）

文档：<https://www.volcengine.com/docs/6369/67269>

与 AWS SigV4 的差异：算法名 `HMAC-SHA256`；签名密钥链以 `HMAC(SK, shortDate)` 起手（无 `AWS4` 前缀），末端为字面量 `request`。

```
CanonicalRequest = METHOD \n "/" \n sortedQuery \n canonicalHeaders \n signedHeaders \n sha256hex(body)
canonicalHeaders = "host:<host>\nx-content-sha256:<payloadHash>\nx-date:<xDate>\n"
signedHeaders    = "host;x-content-sha256;x-date"
StringToSign     = HMAC-SHA256 \n xDate \n "<shortDate>/cn-beijing/ark/request" \n sha256hex(CanonicalRequest)
kSigning         = HMAC(HMAC(HMAC(HMAC(SK, shortDate), "cn-beijing"), "ark"), "request")
Signature        = hex(HMAC(kSigning, StringToSign))
xDate 格式        = 20260511T034034Z（ISO8601 去 - : 和毫秒）
```

Node 内置 `crypto` 即可实现（约 80 行），无需引入 `@volcengine/openapi`。

### 3.3 可选接口

- `GetUsageDetails`（<https://docs.volcengine.com/docs/82379/2479849>）：按模型/时间段拉用量明细，`BillingType` 区分套餐内（`WithinPlan`）/套餐外（`OutsideOfPlan`）。适合后续做按模型的用量视图，本期不实现。
- `ListArkAgentPlanModel`：套餐支持的模型列表。可作为 `refreshModels` 的数据源替代手工维护的 CATALOG，但返回字段与模型元数据（contextWindow 等）未验证，**先不动 CATALOG**。

## 4. 改造设计

### 4.1 目录结构

如实现本方案，将当前单文件包入口拆成以下模块：

```
providers/pi-provider-volcengine-agent-plan/
├── docs/quota-auto-refresh-design.md  # 本文档
├── index.ts                           # provider 注册与扩展事件
├── volc-sign.ts                       # 火山 v4 签名（纯函数，无 IO）
├── ark-api.ts                         # GetAFPUsage 调用与响应解析（可注入 fetch）
└── quota-store.ts                     # 套餐信息缓存读写（见 4.4）
```

`package.json` 的 `pi.extensions` 继续只注册 `./index.ts`，避免重复加载 provider。

### 4.2 AK/SK 的配置存储：复用 auth.json 的 credential.env

不新增配置文件、不读环境变量，与现有 key/tier 同一体系：

- 现有 login 已把 tier 存进 `credential.env[ARK_AGENT_PLAN_TIER]`；
- 新增两个键：`ARK_AGENT_PLAN_ACCESS_KEY_ID`、`ARK_AGENT_PLAN_SECRET_ACCESS_KEY`（仅作为 credential.env 的键名，**不读取 process.env**）；
- 事件/命令中通过 `ctx.modelRegistry.getProviderAuth(PROVIDER_ID)` 解析 provider-scoped env 取回 AK/SK（该 API 不需要已加载模型）。

### 4.3 login 流程变更（auth.apiKey.login）

```
1. prompt secret：Agent Plan API Key（现状）
2. confirm：是否配置火山 Access Key 以自动刷新套餐信息与余量？
   ├─ 是 → prompt AK → prompt SK → 不再询问 tier（由首次自动刷新填充；
   │        刷新失败前回退默认 medium）
   └─ 否 → select tier（现状：small/medium/large/max）
3. 存 credential：{ type: "api_key", key, env: { TIER_ENV?: tier, AK?: ak, SK?: sk } }
```

注意：重新执行 `/login volcengine-agent-plan` 会覆盖旧 credential，属预期行为（更新 AK/SK 的唯一入口，无需单独的"改配置"命令）。

### 4.4 tier 解析优先级与缓存

新增缓存文件 `<agentDir>/volcengine-agent-plan-cache.json`：

```jsonc
{
  "planType": "Large",        // 最近一次 GetAFPUsage 返回值
  "fetchedAt": 1778806800000, // epoch ms
  "windows": {                 // 原样缓存四个窗口，供 status/命令渲染
    "fiveHour": { "quota": 50, "used": 12.5, "subscribeTime": 0, "resetTime": 0 },
    "daily":    { "quota": 100, "used": 22.5, "subscribeTime": 0, "resetTime": 0 }
    // ...
  }
}
```

`<agentDir>` = `process.env.PI_CODING_AGENT_DIR ?? ~/.pi/agent`（尊重 pi 的目录覆盖，冒烟测试隔离需要）。

`credentialPlanTier()`（filterModels 用，必须同步）优先级：

1. 缓存文件的 `planType`（映射 `Large→large` 等，非法值忽略）；
2. `credential.env[ARK_AGENT_PLAN_TIER]`（手动，现状）；
3. `process.env[ARK_AGENT_PLAN_TIER]`（现状，保留不动）；
4. 默认 `"medium"`（现状）。

同步读取策略：模块级内存缓存 + mtime 检查；`refreshQuota()` 写文件后同步更新内存，保证同进程即时生效。首次加载文件不存在时直接落到 2/3/4，不报错。

### 4.5 余量刷新与展示

`refreshQuota(ctx, { force?: boolean })`：

1. `getProviderAuth(PROVIDER_ID)` 取 env 中的 AK/SK，缺一即返回（静默，维持手动 tier 展示）；
2. TTL 节流：距上次成功调用 < 60s 且非 `force` 则复用缓存；
3. 调 `fetchAfpUsage()` → 写缓存文件 → 更新 status；
4. 失败时保留旧缓存，status 显示 `Ark <tier> · quota: <错误摘要>`（下一次触发再重试，不弹窗打扰）。

触发点：

| 时机 | 行为 |
| --- | --- |
| `session_start` | 有 AK/SK 则后台刷新（不阻塞启动） |
| `agent_settled` | TTL 节流刷新（每轮对话结束后余量已变化） |
| `/ark-plan-quota` 命令 | `force: true` 强刷并展示详情 |

Status 文案（`ctx.ui.setStatus("volcengine-agent-plan", ...)`）：

- 有数据：`Ark Large · 5h 25% · D 22% · W 30% · M 42%`（百分比 = Used/Quota，已用量）
- 仅手动 tier：`Ark Large`
- 未配置：`Ark: /login volcengine-agent-plan`（仅当前模型属于本 provider 时显示）

Status 仅在 `ctx.model?.provider === PROVIDER_ID` 时设置，切走模型时 `setStatus(id, undefined)` 清除，避免污染其他 provider 的会话。可在 `model_select` 事件里处理切换。

`/ark-plan-quota` 详情输出（`ctx.ui.notify`，无 UI 模式打印）：

```
Agent Plan: Large (auto · updated 12:03)
5h    12.5 / 50    (25%) · resets 14:30
Day   22.5 / 100   (22%) · resets 00:00
Week  150 / 500    (30%) · resets Mon 00:00
Month 850.5 / 2000 (42%) · resets 06-01
```

未配 AK/SK 时命令输出当前生效 tier 及来源（manual/env/default），并提示重新 `/login` 可配置 AK/SK。

### 4.6 不改动清单

- CATALOG 与 `minimumTier` 过滤逻辑（`ListArkAgentPlanModel` 动态化留作后续）；
- `before_provider_request` 中 minimax-m2.7 / kimi-k2.6 的 thinking hack；
- 既有环境变量（`ARK_AGENT_PLAN_TIER`、`KEY_ENV_NAMES`）读取分支；
- baseUrl、authHeader、两种 API（responses/completions）的注册方式。

## 5. 验证计划

1. **签名正确性**：用真实 AK/SK 对 `GetAFPUsage` 发起一次调用（或先在 [API Explorer](https://api.volcengine.com/api-docs?serviceCode=ark) 用同参数在线调试对照），确认不再 `InvalidAuthorization`；本地可用 `node --test` 对 `volc-sign.ts` 做确定性测试（固定 date 快照比对）。
2. **加载冒烟**：`pi --no-extensions -e .pi/extensions/volcengine-agent-plan --list-models`（沿用仓库 `scripts/check-smoke.mjs` 的方式，`PI_CODING_AGENT_DIR` 指向临时目录）。
3. **tier 联动**：配置 AK/SK 后 `/reload`，确认 `/model` 列表按 API 返回 tier 过滤（如 Large 出现 Kimi K3）；删除缓存文件后回退手动 tier。
4. **余量渲染**：`/ark-plan-quota` 强刷，核对四个窗口数值与控制台"套餐概览"页一致。

## 6. 风险与备注

- **IAM 权限**：建议用子账号 AK/SK 并仅授予方舟只读类权限；`GetAFPUsage` 所需的最小 action 权限未在文档中单列，若子账号被拒，需回主账号在 IAM 中补充 `ark:GetAFPUsage`（及后续 `GetUsageDetails`）授权。
- **文档不一致**：`GetAFPUsage` 接口文档示例 Host 写的是数据面域名 `ark.cn-beijing.volces.com`（实测 404），管控面域名 `ark.cn-beijing.volcengineapi.com` 才是正确入口。
- **接口稳定性**：Agent Plan / Coding Plan API 是 2026 年新上的接口组，字段可能调整；`ark-api.ts` 解析应保持防御性（缺字段降级而非抛错）。
- **多账号**：缓存文件为单账号设计；同一 agentDir 切换不同账号的 key 时，缓存会在下一次刷新时被覆盖，无需处理多账号并存。
