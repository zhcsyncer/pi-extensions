# Plan 双层生命周期改造计划

状态：已实现

关联计划：[`submit-plan-tool-display.md`](./submit-plan-tool-display.md)

## 问题

当前 Plan Mode 只有 Plan 文档评审状态：

```text
draft → changes_requested → approved
```

`approved` 表示某个不可变 revision 已经过用户批准，但不表示对应代码已经实现完成。当前 Session state 仍持续保存 `planId` 和 `revision`；批准后的 Widget 也持续显示该 Plan。再次进入 Plan Mode 时，`before_agent_start` 会把这份已批准 revision 作为 `[CURRENT PLAN REFERENCE]` 注入 system prompt。

因此即使用户提出一个明确的新问题，模型也容易把它理解为旧 Plan 的修订并继续传入旧 `planId`。工具允许省略 `planId` 创建新 Plan，但当前 prompt 与 Session 指针对旧 Plan 的突出展示形成了错误默认。

## 判断

对明确的新目标，默认续写旧 Plan 不合理。

但不能简单把 `completed` 加入现有 `PlanStatus`：

- `PlanStatus` 描述的是文档评审生命周期。
- “实现中 / 已完成 / 已放弃”描述的是获批 revision 的工作生命周期。
- 已批准 revision 必须继续保持 `approved` 和内容不可变，即使对应工作后来完成或放弃。

采用两个正交状态机。

## 已选择的方向

### 文档评审状态

保持现有语义：

```text
DRAFT → CHANGES_REQUESTED → APPROVED
```

### 实现生命周期

新增 branch-aware 工作状态：

```text
NONE → IMPLEMENTING → COMPLETED
                    ↘ ABANDONED
```

原则：

- 批准精确 revision 后进入 `IMPLEMENTING`。
- Agent 只有在实现、必要验证和收尾全部完成后，才调用 `complete_plan`。
- 用户可用 `/plan complete` 手动兜底。
- 未完成或存在失败验证时不得标记完成。
- 不根据自然语言最终回复、文件改动或测试命令自动猜测完成状态。
- `COMPLETED` 后再次 `/plan on` 默认开始全新的 Plan，不注入旧 Plan reference。
- `IMPLEMENTING` 或 legacy 状态下再次进入 Plan Mode，必须显式决定是修订当前 Plan，还是关闭当前工作后开始新 Plan。

## 推荐数据模型

### Plan artifact / manifest

保持 `PlanMetadata` 与 `PlanRevision` 的评审语义，不把工作状态写进不可变 revision。

`PlanStatus` 继续是：

```ts
type PlanStatus = "draft" | "changes_requested" | "approved";
```

manifest 版本原则上无需因工作状态升级；Plan 文件和批准 hash 不受影响。

### Branch-aware Session state

升级 `SESSION_STATE_VERSION`，把当前单一 Plan 指针拆成规划焦点和获批工作：

```ts
type PlanWorkStatus = "implementing" | "completed" | "abandoned" | "unknown";

interface PlanningPlanRef {
  planId: string;
  revision: number;
}

interface PlanWorkRef {
  planId: string;
  revision: number;
  approvedHash: string;
  status: PlanWorkStatus;
  startedAt?: string;
  completedAt?: string;
  abandonedAt?: string;
}

interface PlanSessionStateV3 {
  version: 3;
  mode: "normal" | "planning";
  normalTools: string[];
  planning?: PlanningPlanRef;
  work?: PlanWorkRef;
}
```

约束：

- `planning` 只表示当前 Plan Mode 正在新建或修订的文档焦点。
- `work` 绑定精确的 `planId + revision + approvedHash`，避免 completion 错绑到另一 revision。
- 状态通过 `pi.appendEntry()` 保存，因此跟随 Session tree branch。
- `session_tree`、resume 和 reload 从当前 branch 的最新状态恢复；fork 创建新的 Session，继续沿用现有 cross-Session 拒绝策略，不接管原 Session artifact。
- 不从全局 manifest 推断某一 Session branch 的工作完成状态。

## 核心流程

### 1. 新建 Plan

```text
/plan on
  → planning = undefined
  → 不注入旧 Plan reference
  → submit_plan 不带 planId
  → 创建新 Plan
```

提交 draft 后，`planning` 指向新 Plan 当前 revision。

### 2. 批准 Plan

批准时：

```text
planning = approved plan ref
work = {
  planId,
  revision,
  approvedHash,
  status: "implementing"
}
planning = undefined
mode = normal
```

随后恢复普通工具并发送现有 approved implementation handoff。

handoff 需增加明确规则：

- 按获批 revision 实现。
- 完成全部范围并通过必要验证后，将 `complete_plan` 作为最终工具调用。
- 存在失败测试、未实现范围或未解决错误时，不得调用 `complete_plan`。

### 3. Agent 完成实现

新增 `complete_plan` 工具，只在 `work.status === "implementing"` 的 normal mode 激活。

建议参数绑定当前工作：

```ts
complete_plan({
  planId,
  revision,
  summary?,
  verification?
})
```

执行要求：

- `planId`、revision 必须匹配当前 branch 的 work ref。
- 当前 work 必须是 `implementing`。
- 校验 manifest 中对应 revision 仍是 approved，hash 与 `approvedHash` 一致。
- 成功后写入 branch-aware Session state：`status = completed`、`completedAt`。
- 移除 `complete_plan` 活动工具。
- 不修改 approved revision 内容或 review status。
- 返回紧凑 completion 结果，并建议使用 `terminate: true` 作为最终工具调用。

建议 TUI 事件：

```text
✓ PLAN COMPLETED · Add cache invalidation · r2
```

完整实现总结仍由普通 assistant 文本或 tool result `content` 保留；事件只做紧凑投影。

### 4. 用户手动完成

新增命令：

```text
/plan complete
```

行为：

- 仅对当前 `implementing` work 生效。
- 显式确认后标记 completed。
- 提供 Agent 忘记调用工具、用户手动实现或恢复旧 Session 时的兜底。
- 不要求进入 Plan Mode。

### 5. 放弃当前实现

建议同时提供：

```text
/plan abandon
```

行为：

- 仅对 `implementing` 或 `unknown` work 生效。
- 显式确认后标记 abandoned。
- 保留 approved artifact 和历史 transcript。
- 不把 abandoned 误写为 completed。

## 再次进入 Plan Mode 的决策

### 当前 work 为 COMPLETED 或 ABANDONED

`/plan on` 默认开启新 Plan：

- `planning = undefined`
- 不注入旧 `[CURRENT PLAN REFERENCE]`
- 旧 Plan 仅作为历史 completed/abandoned work 和 transcript 事件保留
- 新 `submit_plan` 省略 `planId`

若用户确实要修订旧 Plan，应使用显式入口，例如：

```text
/plan revise
```

### 当前 work 为 IMPLEMENTING

不得默认为旧 Plan，也不得静默开始另一份工作。进入 Plan Mode 时显示选择：

```text
Current Plan is still IMPLEMENTING: OAuth migration · r2

- Revise the implementing Plan
- Mark completed and start a new Plan
- Abandon and start a new Plan
- Cancel
```

选择语义：

- `Revise`：设置 `planning` 为当前 work ref，并注入旧 Plan reference。
- `Mark completed and start new`：先显式完成，再清空 planning 焦点。
- `Abandon and start new`：先显式放弃，再清空 planning 焦点。
- `Cancel`：不切换工具与模式。

不允许“保留一个 implementing work，同时静默创建第二个当前 Plan”；首版保持每个 branch 至多一个当前 work，避免 Widget、completion 和工具激活歧义。

### 当前文档为 DRAFT 或 CHANGES_REQUESTED

自动恢复同一 planning Plan 是合理的，因为它尚未形成另一项获批实现工作：

- 注入 current Plan reference。
- `submit_plan` 继续要求传当前 `planId`。
- revdiff 创建下一不可变 revision。

## Prompt 改造

当前 `[CURRENT PLAN REFERENCE]` 不应再由“Session 有任意 planId”触发。

仅在以下情况注入：

1. 存在 draft/changes-requested `planning`；或
2. 用户通过 `Revise` / `/plan revise` 明确选择获批 work。

新问题的默认 planning prompt 应明确：

```text
No Plan is currently attached for revision.
Create a new Plan and omit planId when calling submit_plan.
```

对于显式 revision：

```text
The user explicitly chose to revise this approved Plan.
Inspect the current workspace and the referenced revision before deciding changes.
Pass this planId only for this revision lineage.
```

模型不得自行根据“最近有 approved Plan”选择旧 `planId`。

## Tool 激活策略

扩展管理的工具集合需包含：

```text
submit_plan
complete_plan
```

规则：

- planning mode：只启用 `submit_plan`，禁用 `complete_plan`。
- normal + implementing：恢复 normal tools，并额外启用 `complete_plan`。
- normal + completed/abandoned/none：移除两个 managed tools。
- snapshot/restore normal tools 时，必须剥离两个 managed tool，防止泄漏。
- resume、tree navigation、reload 后按 branch state 重新计算活动工具。

## Herdr blocked 事件

Plan Mode 对所有等待用户输入的流程触发 Herdr 保留事件：

```ts
pi.events.emit("herdr:blocked", { active: true, label: "plan review" });
// user-facing review / selector / confirmation
pi.events.emit("herdr:blocked", { active: false });
```

已覆盖：

- revdiff 评审：`plan review`
- 无批注后的显式批准选择：`plan approval`
- implementing/legacy work 重入选择：`plan lifecycle decision`
- `/plan complete` 确认：`plan completion confirmation`
- `/plan abandon` 确认：`plan abandonment confirmation`

所有 active 事件都通过 `finally` 平衡清除。事件 listener 异常不得破坏 Plan 流程；非 Herdr 环境没有 listener，因此不增加 CLI、socket 或运行时依赖。现有 Herdr tool/event adapter 与直接事件采用计数语义，可安全嵌套。

## Widget 与 transcript

### Widget

Widget 需要区分文档状态与工作状态。建议主状态显示当前用户最关心的阶段：

```text
▌ PLAN  OAuth migration                         IMPLEMENTING · r2
▌ PLAN  OAuth migration                           COMPLETED · r2
▌ PLAN  OAuth migration                           ABANDONED · r2
```

展开后补充：

```text
Document: APPROVED
Approved hash: sha256:...
Plan: ~/.pi/agent/plans/.../revisions/r2.md
```

当新 Plan 产生 draft 时，Widget 切换到新的 planning Plan；旧 completed Plan 仍可从 transcript 和持久化 artifact 审计。

### Transcript

建议新增紧凑事件：

```text
✓ PLAN COMPLETED · OAuth migration · r2
! PLAN ABANDONED · OAuth migration · r2
```

这些事件应有历史 renderer。是否进入模型上下文需在实施前确认：

- TUI-only custom entry 更节省模型上下文；
- custom message 可让后续模型明确知道旧工作已关闭。

推荐：Session state 作为真相，completion/abandon event 用 TUI-only custom entry；下一次 planning prompt 根据 state 明确说明没有 attached revision。

## Legacy Session 迁移

不能把所有旧 `approved` 指针直接推断为 completed，也不能假设仍在 implementing。

V2 Session 恢复建议：

- draft / changes_requested → `planning`，不创建 work。
- approved → `work.status = "unknown"`，绑定现有 revision/hash。
- `unknown` Widget 保持接近当前 `APPROVED` 展示。
- 进入 Plan Mode 时按 implementing 类似方式显式询问：修订、标记完成并新建、放弃并新建、取消。
- `/plan complete` 与 `/plan abandon` 接受 unknown 作为迁移兜底。
- 不重写旧 JSONL entry；仅在下一次状态变化时追加 V3 entry。

## No-session 行为

`--no-session` 下仍在内存中维护双层状态：

- 工具激活和当前进程内 UX 一致。
- 不追加 Session state。
- shutdown 后临时 Plan 与生命周期状态一起消失。
- 不承诺跨进程 completion 恢复。

## 失败与边界

- `complete_plan` 参数不匹配当前 work：拒绝，不改变状态。
- approved hash 或 revision 完整性校验失败：拒绝完成并提示重新检查。
- 测试失败但模型调用 complete：prompt 明确禁止；工具无法通用判断任意项目验证结果，因此最终仍是显式 Agent/User 声明，而不是证明系统。
- completion 后 tree 跳回旧 branch：按该 branch 的最新 Session state 恢复，不能被另一 branch 的 completion 污染。
- completed Plan 被显式 revise：新 revision 获批后创建新的 implementing work，绑定新 revision/hash。
- changes requested 不创建 implementing work；只有批准才创建。
- Keep planning / cancelled review 保持 planning 文档焦点，不改变现有 work。

## 实际实现范围

已修改：

- `packages/pi-plan-mode/src/types.ts`
- `packages/pi-plan-mode/src/policy.ts`
- `packages/pi-plan-mode/src/prompts.ts`
- `packages/pi-plan-mode/src/widgets.ts`
- `packages/pi-plan-mode/extensions/plan-mode.ts`
- `packages/pi-plan-mode/README.md`
- `packages/pi-plan-mode/README.zh-CN.md`

已新增：

- `packages/pi-plan-mode/src/lifecycle.ts`
- `packages/pi-plan-mode/src/tool-display.ts`
- `packages/pi-plan-mode/src/herdr.ts`
- `packages/pi-plan-mode/tests/lifecycle.test.ts`
- `packages/pi-plan-mode/tests/tool-display.test.ts`
- `packages/pi-plan-mode/tests/herdr.test.ts`

并扩展 extension、policy、prompt 与 widget 测试。approved artifact 完整性继续复用 `storage.ts` 的 `verifyApprovedPlan()`，manifest 不新增 work status。

## 验收标准

1. Plan 文档 review status 与实现 work status 明确分离。
2. 批准后当前 branch 进入 implementing，并只绑定精确 approved revision/hash。
3. Agent 和用户都能显式完成当前 Plan。
4. completed 后再次进入 Plan Mode 默认新建，不注入旧 Plan reference。
5. implementing/legacy 状态重入时不静默续旧或静默新建，必须显式选择。
6. draft/changes requested 可自动继续同一 revision lineage。
7. completed/abandoned 不修改 approved revision 或 hash。
8. Session resume、reload 和 tree navigation 保持 branch-aware 行为；fork 不越过既有 Session ownership 边界。
9. V2 approved Session 不被误判为 completed。
10. managed tools 不泄漏到错误模式。
11. Widget 和 transcript 能表达 implementing/completed/abandoned。
12. 原有 revdiff、审批、不可变 revision、工具恢复和 handoff 行为继续通过。

## 实施决议

- `complete_plan` 强制要求精确 `planId`、revision、非空 `summary` 和至少一个成功 `verification` 项。
- completion/abandon event 使用 TUI-only custom entry；branch-aware Session state 是生命周期真相。
- `/plan revise` 只挂载当前 branch 的最近 work，不提供全局 Plan selector。
- implementing/legacy 重入选择器依次提供：修订、完成后新建、放弃后新建、取消；没有静默默认。
- completed/abandoned Widget 在 normal mode 保留；进入未挂载的新 Plan Mode 时隐藏，首次提交后切换到新 draft。
- `complete_plan` 返回 `terminate: true`，并由 prompt 要求作为唯一且最终的工具调用。
- 首版每个 branch 至多保留一个当前 work；不允许在旧 work 仍 implementing 时静默开启第二个 current work。
