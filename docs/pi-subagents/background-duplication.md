# pi-subagents 后台委派重复工作问题分析与推荐修复方案

## 状态

调查与三路独立评审已完成，推荐方案已收敛并于当前分支实施。实现保持本文 P0 边界：手动 Agent-tool background 使用 `steer`，scheduler/RPC 默认 `followUp`，并同步收紧模型合同与确定性测试；未引入本文明确排除的扩展机制。

本文固定问题事实、初始候选方案、独立评审结论与推荐终稿，避免后续实施依赖口头上下文。

## 观察样本

来源 session：

```text
/root/.pi/agent/sessions/--root-.herdr-worktrees-ai-chatbot-fix-m14-internal-probe-boundary--/2026-08-13T08-26-26-365Z_019ffa3a-d0bd-7858-9d3b-8ec1b0090ad5.jsonl
```

任务要求移除一项 internal probe shared bearer 协议，同时保持既有 probe route、边界、集成测试和文档合同。

### 时间线

1. `08:27:50.558Z`：主 agent 启动一个后台 `Explore` sub-agent，要求全面梳理 secret/bearer 协议在 chat、admin、integration、standalone、Playwright、workspace contract、`.env` 和文档中的影响面。
2. sub-agent 运行期间，主 agent 自己继续执行几乎相同的全仓 grep 和关键文件读取。
3. `08:29:03.785Z`：sub-agent 完成，结果作为 `subagents:record` custom entry 写入 session。
4. 主 agent 没有调用 `get_subagent_result`，JSONL 中也没有进入模型上下文的 `subagent-notification`；随后直接开始编辑。

### 重复程度

在派发到完成的 `73.227s` 窗口内：

- 主 agent：37 次工具调用；
- sub-agent：31 次工具调用；
- 双方至少有 12 个完全相同的显式 read/list 目标，包括：
  - `apps/chat-web/lib/provider-probe/http.ts`
  - `apps/chat-web/lib/provider-probe/runtime.ts`
  - `apps/chat-web/lib/provider-probe/service-auth.ts`
  - `apps/chat-web/proxy.ts`
  - `apps/admin-console/lib/provider-probe/config.ts`
  - `apps/admin-console/lib/provider-probe/client.ts`
  - `apps/admin-console/lib/provider-probe/http.ts`
  - `apps/admin-console/lib/provider-probe/runtime.ts`
  - `playwright.config.ts`
  - `tests/standalone/health.test.ts`
  - `tests/workspace/provider-probe-contract.test.ts`
  - `apps/chat-web/lib/provider-probe/provider-probe.integration.ts`
- 主 agent 还重复执行了 secret、service-auth、bearer、测试和文档的广域 grep。

编辑前重读少量高风险文件本可算必要验证，但这里连“发现影响面”本身也全量重做，属于实质重复委派。

### 额外质量信号

sub-agent 报告曾建议删除 chat internal probe route，但用户要求明确规定该 route 必须保留。这说明：

- sub-agent 结果不能不经判断直接实施；
- “主 agent 负责理解和综合”是必要原则；
- 但该原则不等于主 agent 应重新执行整轮证据收集，只应在拿到报告后定向抽查高风险结论。

## 根因

### 1. 派发方式与依赖关系不匹配

这次 Explore 结果是后续实施的前置输入，却使用了 `run_in_background: true`。与此同时，没有给主 agent 留出一条明确且互不重叠的并行工作流。

正确选择应是：

- **结果是下一步 read/edit/decision 的前置条件**：foreground；
- **主 agent 有可明确描述的独立工作**：background；
- **目标已经明确、直接工具更便宜**：不派 sub-agent。

### 2. completion notification 使用 `followUp`，完成结果被长工具循环饿死

当前 `packages/pi-subagents/src/index.ts` 的 individual/group completion 都调用：

```ts
{ deliverAs: "followUp", triggerTurn: true }
```

Pi 对消息队列的定义是：

- `steer`：当前 assistant turn 已发出的工具调用结束后、下一次 LLM 调用前交付；
- `followUp`：等 agent 不再继续发工具调用后才交付。

因此后台 agent 即使已经完成，只要主 agent 持续工具循环，结果也不会进入它的下一次推理上下文。`pi.appendEntry("subagents:record", ...)` 只负责持久化，不参与 LLM context，不能弥补这一点。

### 3. 现有提示没有运行时约束

当前工具描述和派发结果已经分别包含：

- 不要重复 sub-agent 正在做的搜索；
- `Do not duplicate this agent's work.`

样本仍然发生重复，说明仅追加同类提示不足以稳定修复。现有措辞也容易与 `Never delegate understanding` 产生误读：模型可能把“保留理解责任”执行成“把所有证据重新收集一遍”。

### 4. 后台任务缺少显式所有权边界

Agent 调用只描述 sub-agent 做什么，没有要求主 agent说明“等待期间自己做什么”。工具和运行时无法判断 background 是否真的有并行价值。

## 目标行为

1. 若 sub-agent 结果是实施前置条件，主 agent 必须等待 foreground 结果，不得后台派发后自行重做。
2. 手动启动、服务于当前任务的后台 agent 一完成，其结果应在下一次 LLM 调用前可见，而不是等整个长工具循环结束。
3. scheduled/RPC 等脱离当前推理链的任务不应随意中断当前工作。
4. 主 agent 保留最终综合和验证责任，但验证应为定向抽查，不是全量重跑。
5. 修复不依赖猜测自然语言任务是否“相似”，也不以脆弱的路径锁作为第一版硬门禁。

## 初始候选方案

评审前提出四部分候选：

1. 手动 background 强制增加自然语言 `parent_task`，要求主 agent 声明等待期间的独立工作流；
2. 当前任务的手动 background completion 从 `followUp` 改为 `steer`，scheduler/RPC 保持 `followUp`；
3. 澄清 foreground/background 选择和“理解责任不等于全量重搜”；
4. 第一版不做路径硬阻塞，视需要再增加 overlap telemetry 或软警告。

三路评审一致接受第 2、3 项，一致否决把第 1 项作为 P0 强制 API，并同意第 4 项至少不进入 P0。

## 三路独立评审

### 共识

- 样本确有实质重复；根因同时包含错误的 background 选择与 completion 被 `followUp` 饿死。
- `steer` 只能让完成结果在下一次 LLM 调用前可见，不能撤回同一 assistant turn 已经发出的 sibling tool calls。
- 手动 Agent-tool background 应使用 `steer`；scheduler/RPC 等 detached 来源默认保持 `followUp`。
- 不应通过 `invocation?.runInBackground` 或 `isBackground` 猜交付策略，应在 spawn 时直接写明。
- 强制 `parent_task` 不可验证、容易填空话绕过，还会扩大 schema/frontmatter/兼容面；不应进入 P0。
- full/compact tool description、`promptGuidelines` 和派发回显都应明确：前置结果必须 foreground；background 期间不得重做证据收集；收到报告后只做定向抽查。
- 第一版不做路径锁，也不写“模型一定不会重复”的随机性测试。

### 分路意见

#### `xai/grok-4.6`

- 推荐最小 `SpawnOptions.completionDelivery?: "steer" | "followUp"`，默认 `followUp`，仅 Agent 工具手动后台显式传 `steer`。
- 认为 `AgentOrigin` 状态机、强制 `parent_task`、group 混类隔离和 P0 telemetry 都属过度设计。
- 指出 smart group 只收同一 assistant turn 的 Agent-tool 调用，scheduler/RPC 不进入该 batch，因此当前天然同质。

#### `volcengine-agent-plan/kimi-k3`

- 同意 `steer` 是 P0，倾向用显式 `origin` 区分 Agent tool、scheduler、RPC。
- 同样否决强制 `parent_task`；若未来保留门禁，必须依据 `resolvedConfig.runInBackground`，不能检查原始 `params.run_in_background`，否则 custom-agent frontmatter 会绕过或误伤。
- 同意当前 group 天然同源，无需第一版引入拆组机制；暂不做 telemetry。

#### `ollama-cloud/glm-5.2`

首次运行触及 turn limit；沿原会话停止检索并收束后产出评审。

- 同意手动 background 用 `steer`、scheduler/RPC 用 `followUp`，并否决强制 `parent_task`。
- 倾向直接保存 `completionDelivery`，不增加 `AgentOrigin`。
- 对未来不同 delivery class 混组更保守，建议若真的出现则拆组；将 overlap telemetry 视为 P1 而非 P0。

### 分歧与取舍

1. **记录 origin 还是记录交付策略**：采用 Grok/GLM 的 `completionDelivery`。运行时真正需要的是消息交付行为；记录 origin 再映射一次没有额外价值。
2. **是否处理混合 delivery group**：P0 不做。现有 `currentBatchAgents` 只包含同一轮 Agent-tool background，scheduler/RPC 不参与；增加同质性测试和代码注释即可。未来若其他来源进入 group，再按真实用例拆组。
3. **是否立即加 telemetry**：延后。当前已有足够证据修复明确的队列问题；先观察修复后是否仍复发，再决定采集什么信号。

## 推荐终稿

### P0-1 · 为每个后台记录固定 completion delivery

增加最小类型和记录字段：

```ts
type CompletionDelivery = "steer" | "followUp";

interface AgentRecord {
  // ...
  completionDelivery: CompletionDelivery;
}

interface SpawnOptions {
  // ...
  completionDelivery?: CompletionDelivery;
}
```

`AgentManager.spawn()` 创建记录时固定：

```ts
completionDelivery: options.completionDelivery ?? "followUp"
```

调用策略：

| 调用路径 | 策略 |
|---|---|
| Agent 工具手动 background，包括 frontmatter 默认 background | 显式 `completionDelivery: "steer"` |
| scheduler | 省略，默认 `followUp` |
| RPC/detached | 省略，默认 `followUp` |
| foreground | inline result，不依赖后台 nudge |

不新增 `AgentOrigin`，也不从现有 UI 字段反推来源。

### P0-2 · completion notification 使用记录上的策略

individual notification：

```ts
pi.sendMessage(message, {
  deliverAs: record.completionDelivery,
  triggerTurn: true,
});
```

smart/group notification 使用该组首条记录的策略；通过测试固定“当前 batch 全部是 Agent-tool background，因此同为 `steer`”这一不变量。P0 不新增混类拆组逻辑。

结果：手动 background 完成后，通知会在主 agent 当前已发出的工具批次结束、下一次 LLM 调用前进入上下文；scheduled/RPC 不会中途打断当前任务。

### P0-3 · 收紧模型合同与派发回显

统一更新 full/compact description、`promptGuidelines`、`examples/agent-tool-description.md` 和后台派发结果：

> 若 sub-agent 结果是下一次 read、edit 或 decision 的前置条件，必须 foreground。只有存在真正互不重叠的工作时才使用 background。

> 主 agent 保留综合、决策和最终验证责任，但不得重复 sub-agent 的证据收集。收到结果后只抽查高风险结论，不得全量重跑相同 grep/find/read。

后台返回文本应明确：继续时只能做 genuinely disjoint work；结果完成后会通知，无需轮询，也不得同时重搜。

不新增强制 `parent_task`。若修复后仍频繁复发，再基于数据评估可选 ownership 字段，而不是先扩公开 schema。

### P0-4 · 同步维护边界与用户文档

至少同步：

- `packages/pi-subagents/README.md`
- `packages/pi-subagents/README.zh-CN.md`
- `packages/pi-subagents/CHANGELOG.md`
- `packages/pi-subagents/UPSTREAM_SOURCE.md`
- `packages/pi-subagents/examples/agent-tool-description.md`
- 对应 changeset

`UPSTREAM_SOURCE.md` 当前将 background followUp notifications 标为有意保持的上游行为；实现时必须改成“手动 Agent-tool background 使用 steer，detached/scheduled 保持 followUp”。发版继续遵守 Changesets version PR 流程。

## 验证设计

使用 mock `runAgent`、fake timers 和 `pi.sendMessage` spy，测试确定性的编排行为，不调用真实模型：

1. Agent 工具手动 background 完成：`deliverAs === "steer"` 且 `triggerTurn === true`。
2. custom-agent frontmatter 默认 background 也走 `steer`。
3. scheduler completion：保持 `followUp`。
4. RPC completion：默认 `followUp`。
5. foreground `spawnAndWait`：只返回 inline result，不发后台 nudge。
6. 同 turn 两个手动 background 经 smart join：单条 group notification，使用 `steer`。
7. `get_subagent_result` 在 200ms hold window 内消费结果：取消待发 nudge。
8. `wait: true` 被取消：不终止或消费 child，child 完成后仍按记录策略通知。
9. error/aborted/stopped：使用同一 delivery 策略，widget/fleet 正常收尾。
10. full/compact descriptions 与示例模板包含 foreground 前置条件和禁止重复收集规则。

若需要验证 Pi 自身队列语义，使用 stub agent loop 断言 streaming 状态下 `steer` 进入 steer queue、`followUp` 进入 follow-up queue；不通过真实模型输出证明。

## 明确不做

- 不强制增加 `parent_task` 或 `parallel_plan`；
- 不增加 `AgentOrigin` 状态机；
- 不做路径级读写锁、`delegated_paths` 或自然语言重叠判断；
- 不在 P0 增加 overlap telemetry；
- 不改变 scheduler/RPC 的默认通知时序；
- 不声称本方案能撤回同 turn 已发出的重复 sibling tools。

## 残余风险与后续触发条件

- 同 turn sibling 重复仍只能依靠更清晰的派发合同规避；`steer` 解决的是完成结果在后续轮次被饿死。
- `steer` 会让真正并行任务的结果更早进入主推理链，可能改变原定 parent lane；这是及时消费结果的预期权衡，需在 changeset 中明示。
- 多个未成组 steer 在默认 `one-at-a-time` 下可能跨 turn 串行；现有 smart group 是主要缓解。
- 若上线后仍观察到重复委派，再增加只读 overlap telemetry，先测量 read/grep/find 重叠，再决定是否需要可选 ownership 字段或软警告；没有数据前不加硬门禁。
