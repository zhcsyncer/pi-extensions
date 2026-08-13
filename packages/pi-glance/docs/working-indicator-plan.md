# Glance Working Indicator 实施方案

状态：Ready for implementation

目标分支：`feat/glance-working-indicator`

目标包：`@zhcsyncer/pi-glance`

参考行为：Claude Code 2.1.x working row；只借鉴可见行为，使用 Pi 公共扩展 API 独立实现，不复制或依赖 `pi-claude-shimmer`。

## 1. Goal

把 Claude Code 风格的丰富 working row 纳入 Glance 的统一 TUI 外观：

- Glance 启用 working indicator 时，接管 Pi 的 `setWorkingMessage()` 和 `setWorkingIndicator()`。
- 星形往返动画、动词 shimmer、当前活动、当前 run 输出 token 和耗时自动呈现。
- 所有颜色跟随 Glance 当前 `Color source`：`Follow Pi` 使用 Pi semantic theme tokens，`Glance palette` 使用当前 light/dark palette。
- 关闭后立即停止定时器并恢复 Pi 原生 working message 与 spinner。
- 仅改变显示，不改变 prompt、模型、工具、消息、session 或 agent 行为。

## 2. 产品决议

### 2.1 只有一个功能开关

在 `/glance` 一级菜单增加：

```text
Working indicator
  Enabled: on | off
```

该一级项只有这一行开关，不增加显示细项。配置 GUI 从子列返回时保留原父项，并为每个一级项记住上次选中的子项。

配置形态：

```ts
workingIndicator: {
  enabled: boolean;
}
```

约束：

- 不增加 Minimal/Whimsical、Details、Tokens、Elapsed、Thinking、Shimmer speed 等细项。
- `on` 表示用户选择完整体验；丰富度由当前状态和终端宽度自动决定。
- `off` 表示 Glance 不再占用 working row，并调用无参数 `setWorkingMessage()` / `setWorkingIndicator()` 恢复 Pi 默认。
- 顶层 `config.enabled === false` 时同样不得保留 Glance working UI 或 timer。
- 首版默认 `on`；旧配置迁移到新 schema 后也使用默认 `on`。

Pi 的 working row 是全局单例、没有 key 或 owner stack。文档说明：同时启用多个 working-indicator 扩展时，最后写入者生效；Glance 关闭时只能恢复 Pi 默认，不能恢复另一扩展先前的私有值。

### 2.2 固定的完整体验

启用后自动提供：

1. 主题化星形 ping-pong spinner。
2. 每个高层 agent cycle 选择一次趣味动词，直到 `agent_settled` 保持稳定。
3. 动词上的逐 grapheme shimmer。
4. requesting / thinking / responding / tool-use 活动投影。
5. thinking effort（可用时）。
6. 当前高层 agent cycle 的实时输出 token；未完成部分明确标为估算。
7. 当前高层 agent cycle 的人类可读 elapsed time，并只对长耗时字段做渐进强调。
8. 窄终端自动删减次要信息。
9. 安全的长时间无增量提示色；不在正常 thinking、requesting 或工具执行期间误报。

不弹完成通知，不向 transcript 添加完成行；`agent_settled` 后 working row 自然消失并恢复 Pi 默认。

## 3. 用户可见行为

宽度允许时，状态示例：

```text
✢ Brewing…
✶ Brewing… (thinking with high effort · ↓ ~42 tokens · 8s)
✻ Brewing… (↓ ~127 tokens · 12s)
✽ Brewing… (running bash · ↓ 184 tokens · 18s)
✢ Brewing… (requesting · ↓ 184 tokens · 19m 15s)
```

语义：

- `~`：当前未完成 assistant message 含估算部分。
- 无 `~`：当前显示值全部来自已完成 assistant message 的 provider-reported `usage.output`。
- `↓ N tokens`：仅指当前高层 agent cycle 的模型输出，不是 session 累计，也不是 context window。
- 工具自身嵌套 LLM usage 不计入该 working 值；它属于 Glance session 累计 usage。
- elapsed 使用 `47s`、`3m 08s`、`1h 07m` 形态；一小时后省略低价值秒数。

终端变窄时自动降级，不新增用户设置。通常保留顺序：

1. spinner 与主文案始终保留；
2. thinking/tool 当前活动；
3. 当前 run token；
4. elapsed time；
5. 最终才截断主文案。

elapsed 达到 5 分钟进入 warning 后，在降级时优先于当前 run token 保留，但仍不抢占当前活动。Responding 状态本身可由 token 增长表达，无需额外显示 `responding`。首次请求且无更多事实时，一分钟内只显示主文案；一分钟起主动显示 elapsed。

## 4. Token 口径

Working token 与现有 Glance 指标是不同窗口：

| 显示位置 | 窗口 | 来源 |
|---|---|---|
| Working row | 当前高层 agent cycle 的 output | 已完成消息用正式 `usage.output`；当前流用 Pi `estimateTokens()` |
| Glance Tokens segment | 当前 session 累计 input/output/cache | provider-reported usage，含 assistant、嵌套 LLM tool、compaction、branch summary |
| Glance Context | 当前 context window 占用 | `ctx.getContextUsage()` |

实现规则：

```text
workingOutput = sum(finalized assistant usage.output)
              + estimate(current partial assistant message)
```

- 使用 `@earendil-works/pi-coding-agent` 公开导出的 `estimateTokens()`，不要另写 `chars / 4`。
- `message_update` 每次保存最新完整 partial assistant message；现有约 120ms 单 ticker 每帧至多重新估算一次，因此覆盖 text、thinking 和已组装的 tool call arguments，避免 delta 重复累计与逐 chunk 全量扫描。零值估算不显示 `↓ ~0 tokens`。
- `message_end` 收到 assistant message 后，以正式 `message.usage.output` 替换当前 partial estimate，并加入 finalized 总数。
- 使用 `responseId`（存在时）防止 finalized usage 重复计入；无 `responseId` 时依赖单次 `message_end` 契约。
- 高层 cycle 第一次 `agent_start` 时清零；自动 retry/compaction 触发的后续 `agent_start` 若尚未 `agent_settled`，保留 verb、起始时间和累计输出。
- `agent_settled`、session shutdown、disable 后清零。
- 数字可以平滑追赶目标，但测试必须使用可注入 clock/timer，不得依赖真实睡眠。

## 5. 生命周期与状态机

建议新增独立的纯状态模块和 UI controller，不把高频动画状态塞进现有 `GlanceState` session snapshot。

状态：

```ts
type WorkingPhase =
  | "idle"
  | "requesting"
  | "thinking"
  | "responding"
  | "tool-use";
```

事件映射：

- `session_start`：读取配置；启用时准备 controller，但 idle 不显示。
- 首次 `agent_start`：开始高层 cycle、选择 verb、清零 token/clock、phase=`requesting`、启动 ticker。
- settled 前再次 `agent_start`：视为 retry/continuation；保留 cycle 数据，仅 phase=`requesting`。
- `turn_start`：phase=`requesting`。
- `message_update`：
  - `thinking_start|thinking_delta` → `thinking`
  - `text_start|text_delta|text_end` → `responding`
  - `toolcall_start|toolcall_delta|toolcall_end` → 保持当前生成阶段；真正执行前仍可显示 responding
  - 每次立即更新 phase 与 last-progress timestamp，并替换待估算的最新完整 partial；单 ticker 在下一帧合并估算和渲染
- `message_end` assistant：finalize provider output usage；清除 current partial estimate。
- `tool_execution_start`：记录 toolCallId/toolName；phase=`tool-use`。
- `tool_execution_end`：移除对应工具；仍有并发工具则保持 `tool-use`，全部结束则 phase=`requesting`，等待下一 turn。
- `turn_end`：不结束高层 cycle。
- `agent_end`：不清空；Pi 可能仍会 retry、compact 或继续 queued message。
- `agent_settled`：停止 ticker、恢复 Pi 默认、清空 cycle。
- `session_shutdown`：幂等执行完整 cleanup。
- 配置从 on→off 或顶层 enabled→off：立即 cleanup；off→on 时若当前已有活跃 cycle，不要求逆向重建丢失历史，下一次 `agent_start` 正常开始。

必须用 `toolCallId` 追踪并行工具；单工具显示 `running <toolName>`，多个显示 `running N tools`。只显示安全 tool name，不展示 arguments。

## 6. 动画与主题

### 6.1 Spinner

基础 glyph：

```ts
["·", "✢", "✱", "✶", "✻", "✽", "✻", "✶", "✱", "✢"]
```

- 不重复往返点。
- 每个 frame 必须恰好一列；使用 `visibleWidth()` 检查，异常 glyph 退化为 `*`。
- `intervalMs` 约 120ms。
- frame 使用当前 resolved Glance title/accent style。
- 若 runtime theme / color source cache key 变化，重新安装已着色 frames。

### 6.2 Shimmer

- 不做写死 Claude RGB，也不解析/插值 ANSI。
- base 使用 resolved Glance `title`；highlight 使用 resolved Glance `text`；辅助信息使用 `dim`；长 elapsed 使用 `text` / `warn`；stall 使用 `error`。
- 使用 `Intl.Segmenter` 的 grapheme segmentation；不可用时回退 `Array.from()`。
- shimmer 位置按可见终端列而不是 UTF-16 index 计算；使用 `visibleWidth()`。
- requesting 从左向右，其余生成阶段从右向左。
- 使用 elapsed-time-based position，而不是依赖 tick 次数，避免 timer 抖动造成速度漂移。
- 主题函数应从现有 `resolveRuntimeRenderStyleContext()` / `resolveGlanceRenderStyles()` 懒解析，保持 `Follow Pi` 的 runtime theme switching 和 Glance palette 一致。

### 6.3 Ticker 与 cleanup

- controller 最多维护一个 animation timer；禁止每个 turn/tool 创建额外未管理 interval。
- timer callback 只计算内存字符串并调用 `setWorkingMessage()`；不得做 IO、读取 git 或扫描 session。
- 重复 start/stop/disable/reload 必须幂等，无 timer 泄漏。
- 尽量把 clock、scheduler、random 注入 controller，便于确定性测试。

### 6.4 Elapsed

- `<1m`：秒数，例如 `47s`，使用 `dim`。
- `1m–<5m`：分钟与零补齐秒数，例如 `3m 08s`，只把 elapsed 字段提升为 `text`。
- `>=5m`：同样的人类可读格式，elapsed 字段使用 `warn`；不因总时长把整行或主文案标为错误。
- `>=1h`：显示小时与零补齐分钟，例如 `1h 07m`，省略秒数以控制宽度。
- 无活动和 token 事实时，一分钟前保持主文案-only；一分钟起仍显示 elapsed。

### 6.5 Stall

首版保留安全版本：

- 只在 phase=`responding` 且已经收到至少一个生成增量后，连续 10s 无任何 assistant progress 才进入 stall 色。
- requesting、thinking、tool-use 不判 stall。
- 新增 message progress、切 phase 或进入工具执行后立即解除。
- stall 仅改变视觉，不产生通知，不中止或重试请求。

## 7. 配置与迁移

- `GlanceConfig.version`：12 → 13。
- 新增 `workingIndicator.enabled`，默认 `true`。
- 更新：`types.ts`、`config.ts` 的 default/clone/normalize/shape、配置测试和 README schema 文案。
- `/glance` 一级菜单增加独立 `Working indicator` 项，其中只保留一行 `Enabled` toggle；不增加显示细项。
- 保存配置后立即安装或移除 working controller，无需 `/reload`。
- 不直接修改 package version；版本由 Changesets version PR 处理。

## 8. 推荐模块边界

建议新增：

```text
packages/pi-glance/
├── working-indicator-state.ts       # 纯生命周期、token/accounting、tool 并发状态
├── working-indicator-renderer.ts    # glyph、grapheme shimmer、宽度降级、文案
├── working-indicator.ts             # Pi UI controller、timer、主题重装与 cleanup
└── docs/working-indicator-plan.md    # 本方案
```

可按实现需要调整文件名，但必须保持：状态计算可纯测、渲染可纯测、Pi 事件编排与 timer 副作用集中。

在 `index.ts` 注册新增事件，在 `runtime.ts` 或独立 controller adapter 中统一接线。不要把 working 高频 refresh 接入现有 `RuntimeRefreshSession`，该类负责低频 input-surface/session facts；两者变更原因和刷新频率不同。

## 9. 测试影响

至少覆盖以下契约：

### 9.1 状态与 token

- 首次 agent_start 清零并开始；settled 前重试不清零。
- partial assistant 估算被 final `usage.output` 正确替换，不双计。
- thinking/text/tool call partial 都进入估算。
- 多个 assistant turn 累计当前 cycle output。
- responseId 去重。
- 并行工具名称/数量和 phase 转换。
- agent_end 不清理，agent_settled 清理。

### 9.2 Renderer

- spinner 无重复端点且每帧一列。
- shimmer 方向正确，grapheme/emoji/组合字符不被拆坏。
- base/highlight/dim/text/warn/error 使用 resolved Glance semantic styles。
- `~` 只在含 partial estimate 时出现。
- elapsed 在 60s、5m、1h 边界使用规定格式和强调级别。
- 宽度降级按规定优先级，warning elapsed 优先于 token，任何输出不超过预算。
- stall 只在安全条件下出现并可恢复。

### 9.3 Controller

- on 时接管；off、顶层 disable、settled、shutdown 时调用无参数 restore。
- 重复 start/stop 不产生多个 timer。
- runtime style cache key 变化时重装 spinner frames。
- 配置保存立即应用。
- 非 TUI 模式不启动 timer、不调用 TUI-only行为。

### 9.4 配置、文档与回归

- schema 13 default/clone/normalize/drop-field/migration 测试。
- settings catalog 只有一个 Working indicator toggle，并作为独立一级项呈现。
- pane 导航从 values → settings → 原父项逐级返回；重新进入一级项时恢复其上次选中的子项。
- 更新 `README.md` 与 `README.zh-CN.md`，准确区分 working run estimate、session usage 和 context usage。
- 更新根 `README.md` / `README.zh-CN.md` 的 Glance 描述。
- 原有 Glance 全套检查继续通过。

测试使用现有 `scripts/test-*.ts` + `tsconfig.test.json` 模式，并把新增测试加入 `package.json` 的 `test:dev`。不得用只断言内部字段或 timer 实现细节的脆弱测试；测试用户可见字符串、状态契约与 cleanup。

## 10. Changeset 与验证

这是用户可见新增能力，添加 changeset：

```yaml
"@zhcsyncer/pi-glance": minor
"@zhcsyncer/pi-extensions": minor
```

changeset 摘要应说明：Glance 新增可关闭、主题感知的 Claude-inspired working indicator，自动展示活动、当前 run 输出估算和人类可读耗时，并对长 cycle 的耗时字段做 warning 强调。

实现完成至少运行：

```bash
pnpm --filter @zhcsyncer/pi-glance check
pnpm check:smoke
pnpm check:pack
```

若根级检查因与本变更无关的环境条件失败，必须报告命令、错误和已排除范围，不得标记全部验证成功。

## 11. 文档表述

必须明确：

- 这是 “Claude-inspired”，不是 Anthropic 官方组件，也不是逐像素兼容承诺。
- Glance 使用 Pi 公共 API，不改变 Agent 行为。
- `~N tokens` 是当前 cycle 未完成输出的保守估算；finalized message 使用 provider usage 校准。
- 顶栏 Tokens 是 session 累计，Context 是窗口占用，三者不是同一指标。
- Working indicator 是全局单例；并用其他同类扩展时最后写入者生效。
- 关闭该功能会恢复 Pi 默认 working row。

## 12. 验收标准

1. 用户在 `/glance` 一级菜单直接看到 Working indicator，内部只有一个 Enabled 开关，没有细碎显示级别。
2. 从子列返回时保留原父项；重新进入一级项时恢复上次选中的子项。
3. 开启后，spinner、shimmer、活动、thinking effort、当前 run token 和人类可读 elapsed 自动工作；elapsed 在一分钟和五分钟边界渐进强调。
4. 关闭、顶层 disable、settled、shutdown、reload 后 Pi 默认 working UI 被恢复且无 timer 泄漏。
5. 配色严格跟随 Glance 当前 Color source，并响应 runtime Pi theme 与 Glance config 切换。
6. 当前 run token 的估算/正式边界可见且不与 session/context 口径混淆。
7. 自动 retry/continuation 在 `agent_settled` 前保持同一高层 cycle；多个 turn 正确累计。
8. 工具并行状态正确，不因事件时序漏掉 tool-use。
9. Unicode、ANSI 和窄终端安全；working 文案不造成宽度抖动或超宽。
10. 不新增通知、transcript 内容、prompt、工具或模型行为。
11. 中英文包文档、根文档、changeset 和完整验证同步完成。
