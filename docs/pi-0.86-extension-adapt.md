# Pi 0.86 扩展适配结论

状态：**终稿**。主会话核对后，经三路独立审计（Codex GPT-6 / Ollama Kimi-K3 / 火山 GLM-5.3）交叉，并对分歧点做了针对性核验。范围：分支 `adapt/pi-0.86.0`。对照上游 **Pi 0.86.0**。

未跑完整 0.86 编译或真实网关 E2E。下列「必须改」均有本仓库行号 + 官方契约可对上。

## Why

0.86 把系统说明和工具表放进 transcript 的 system 消息。Breaking 打的是 **自己组报文的 stream**，以及 **把旧 `context.systemPrompt` 当可写字段** 的代码。调用官方 `complete`/`streamSimple` 并传入 `{ systemPrompt, messages, tools }` 的，官方仍 `normalizeContext`，不因此损坏。`return { systemPrompt }` 的 cache 语义是 **when it changes**，不是每调用都 miss。

## 必须改

### 1. `pi-provider-cursor-ask`

三路一致。`pi-adapter.ts:404/445` 只读 `context.systemPrompt`、`context.tools`，循环还跳过 `role: "system"`。0.86 提供商入参是 TranscriptContext，这两字段空 → **无系统说明、tools 恒为 []**。用户侧：Cursor 上「按项目规则改代码」变成裸聊天、不调工具。

修法：`getCurrentSystemPrompt` / `getCurrentTools`；Cursor 协议不吃中途 system 则先 `collapseSystemMessages`。`context-usage.ts` 同样改读 messages。

### 2. `pi-fast-mode`

主会话原先低估了它。三路均判必须改；核验：`stream-options.ts:61-76` 把非 user/toolResult 都当 assistant 的 content block 数组遍历。0.86 `SystemMessage.content` 可以是 **string**。`for (const block of message.content)` 会按字符迭代，走到 `block.name.length` → **TypeError**。三个 `registerProvider` 包装器 **不论 Fast 开关** 都走 `buildStreamOptions`。用户侧：装了 Fast Mode 后，OpenAI/Codex/Grok **首轮请求就可能在发网前崩溃**；若 content 已是 block 数组则不崩，但会把 system+tools 计成 0，maxTokens 钳过松。与 compaction 无关。

修法：估算改 `getCurrentSystemPrompt`/`getCurrentTools`（或跳过 `role === "system"` 用 `getSystemMessageText`）。类型改 TranscriptContext。

### 3. `pi-subagents`

Kimi/Codex 判必须，GLM 判验证。核验：0.86 `AgentContext` 只有 `messages` + `tools`，**无 `systemPrompt`**。`agent-runner.ts:1183-1199` 写 `context.systemPrompt` 追加收尾语，agent-loop 只归一化 messages → **turn-limit 软提示丢失**。`isStoredMessage` 白名单无 `system`；0.86 会话会持久化 system 消息 → **resume 可能把合法会话判坏**。用户侧：子代理到上限不收束、硬杀；重启继续子代理失败。对抗审查若复用该 runtime，一并受影响。

修法：收尾改为往 messages 追加 system/user 指示；恢复白名单接纳 `system` 与 `usage` 条目。

### 4. `pi-consult`

仅 Codex 升为必须；机制核验成立。`execute.ts` 把 `convertToLlm(sessionMessages)` 再加 `{ systemPrompt: CONSULT_SYSTEM_PROMPT, tools: [] }` 送给 `streamSimple`。0.86 `normalizeContext` 只把 shorthand 折成 **额外一条** leading system，**不会清掉 messages 里已有的 `toolsAdded`**。`getCurrentTools` 重放全部 system 增量 → 顾问仍看到执行者工具。用户侧：`/consult` 本应只出 JSON 建议，模型可能尝试调 `bash`。不能只改类型名。

修法：顾问请求用干净 transcript（顾问自己的 system + 剥掉父 system/toolsAdded 的对话），不要依赖 `tools: []`。

## 有条件 / 升级后验证

| 包 | 判据 | 用户会看见什么 |
|---|---|---|
| `pi-meter` / `pi-glance` | Codex：`cache_warm` usage 条目不进账本（meter 跳过非 message；glance snapshot 不计 usage）。Grok/GPT 常无 cache TTL，warming 往往不跑。 | 若 warming 真发生：`/usage` 和 Glance tokens 比会话总费用少一截。先观察，真用 Claude 长工具再改。 |
| `pi-search-hub` 托管搜索 | 调用方 `complete({ systemPrompt, messages, tools })`，官方 normalize。 | 登录 Codex/Grok 后搜一条，确认有真实 URL 和 `submit_search_results`。 |
| `pi-recap` | 同调用方；不重放父 tools。 | `/recap` 仍出摘要。 |
| `pi-herdr-companion` `/btw` | 父快照现含 system；子强制 prompt + 拼父消息。稳定 pane 注入仍合法（miss when it changes）。 | 父改工具后再 `/btw`，确认子工具集和合并回父。 |
| `pi-tool-display-intent` | 重注册内置工具；0.86 默认 strict-prefer sampling。克隆是否带上 `constrainedSampling` 未在源码证实。 | bash/edit 参数畸形率若上升再查。 |
| `pi-provider-volcengine-agent-plan` | 官方 `openAIResponsesApi()`，无本地 serializer。 | thinking on/off 与套餐过滤回归即可，**不为 0.86 改组包**。 |
| `pi-plan-mode` / Herdr 主会话注入 | `return { systemPrompt }`。官方：内容变了才 miss。 | 可选改 sections，不挡升级。 |
| `pi-todo` / `pi-ask-user-question` / `pi-context7` | 无自研 stream；todo 已无 live injection。 | 常规回归。 |

本仓库无 `user_bash`。抽查 tool `details` 为普通 JSON。

## 三路对照（终稿如何取舍）

| 项 | 主会话初稿 | Kimi | Codex | GLM | 终稿 |
|---|---|---|---|---|---|
| Cursor | 必须 | 必须 | 必须 | 必须 | **必须** |
| Fast Mode | 验证 | 必须 | 必须（探针 TypeError） | 必须 | **必须**（纠正初稿） |
| 子代理 | 验证 | 必须 | 必须 | 验证 | **必须**（turn-limit + resume 白名单） |
| Consult | 验证 | 验证 | 必须（父 tools 泄漏） | 验证 | **必须**（`tools: []` 清不掉 transcript 工具） |
| Meter/Glance warming | 观察 | — | 有条件必须 | Glance 仅 spinner | **有条件验证** |
| 火山 | 不改 | 验证编译 | 不改 | 验证 thinking | **不改组包** |

## 落地顺序

1. Cursor 组包（否则该 provider 废）。
2. Fast Mode 估算（否则 OpenAI/Codex/Grok 首轮可能崩）。
3. 子代理 turn-limit 与 resume 白名单。
4. Consult 隔离父 transcript。
5. 其余按表做升级回归；warming 账本、Plan/Herdr sections 不挡升级。

## 红线

- 「自定义 provider」= 自己把 context 编成网关报文。火山挂官方 adapter ≠ Cursor。
- Fast Mode 的问题是 **maxTokens 估算遇到 system 字符串**，不是 compaction。
- 不要说 `return { systemPrompt }` 每轮都 miss。
