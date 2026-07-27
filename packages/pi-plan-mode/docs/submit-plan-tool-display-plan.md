# `submit_plan` Tool Call TUI 展示计划

状态：已实现

## 背景

改造前，`submit_plan` 注册了工具定义与执行流程，但没有提供 `renderCall`、`renderResult` 或 `renderShell`。Pi 因而回退到默认工具展示：调用阶段只显示工具名 `submit_plan`，不会显示标题、revision 或评审状态；完成后直接渲染模型可见的原始结果文本。

这与当前 bundle 中已采用的 Claude 风格内置工具行、Plan Widget 和 `PLAN APPROVED` custom event 不一致，也会在要求修改时把完整 annotations 直接铺进 transcript。

## 已确认的展示方向

采用“极简无痕”方案：

- 评审期间只显示一条紧凑、语义化的状态行。
- 要求修改、取消或失败时保留一条历史摘要。
- 批准成功后，收起状态隐藏 `submit_plan` 工具节点，只保留已有的紧凑批准事件。
- 历史 transcript 在展开状态下重新显示关键审计信息。
- annotations 必须能够从历史 Session 展开查看，不依赖当前磁盘上的 review workspace。

## TUI 与模型上下文边界

本展示改动严格限定为 TUI 投影；同批实现的双层生命周期属于关联计划 [`plan-lifecycle-plan.md`](./plan-lifecycle-plan.md)，不属于 renderer 自身职责：

- 不修改工具名称、Schema、参数或 prompt guidance。
- 不增加 `displaySummary`，避免改变模型 tool call arguments 和 token 使用。
- 不修改 Plan 保存、revdiff、审批、工具恢复或 implementation handoff 流程。
- 不修改工具结果的模型可见 `content`。
- Session 继续保存原始 assistant tool call 与 tool result；TUI 在当前渲染器下重新投影这些数据。

现有数据已经足够支持历史渲染：

- Tool call arguments：`title`、`planId`、完整 `markdown`。
- Tool result details：`kind`、`planId`、`revision`、`planPath`、`approvedHash`。
- Tool result content：review feedback、annotations、取消或失败原因。
- Approved custom message：标题、revision、step count、path、hash 和完整获批 Plan。

## 状态展示规格

### 1. 提交与评审中

收起和展开状态均显示紧凑状态行，不展示完整 Markdown：

```text
● Reviewing Plan: Add cache invalidation…
```

可选的窄屏降级：

```text
● Reviewing Plan…
```

### 2. 要求修改

收起状态：

```text
● Plan changes requested · Add cache invalidation · r2
  ⎿ 3 annotations · Ctrl+O to inspect
```

展开状态：

```text
● Plan changes requested · Add cache invalidation · r2

  Annotations
  1. Step 2: add rollback handling
  2. Verification: include an integration test
  3. Risks: document cache stampede behavior

  Plan ID: 20260723T...
  Plan: ~/.pi/agent/plans/.../revisions/r2.md
```

要求：

- annotations 从已持久化的 tool result `content` 提取，历史恢复后仍可查看。
- 不依赖 `.review/annotations.md` 存在；临时 Session 清理后仍须可审计。
- 展开内容设置视觉行预算，超出时显示 `… +N more`。
- annotation 数量只有在格式可可靠解析时才显示精确值；否则使用 `Review annotations available`，不得猜测数量。

### 3. 批准成功

收起状态隐藏 `submit_plan` 工具节点，只保留：

```text
✓ PLAN APPROVED · Add cache invalidation · r2 · 6 steps
```

当全局工具输出处于展开状态时，允许 `submit_plan` 节点重新出现，提供审计元数据：

```text
Submit Plan · Add cache invalidation · r2
  Plan ID: 20260723T...
  Plan: ~/.pi/agent/plans/.../revisions/r2.md
  Approved hash: sha256:...
```

不在此节点重复完整获批 Plan；完整内容已存在于 approved custom message 的模型上下文和 Session 中。

### 4. Keep planning / Cancelled

收起状态保留一行，避免看起来像批准成功：

```text
● Plan review kept as draft · Add cache invalidation · r2
```

或：

```text
● Plan review cancelled · Add cache invalidation · r2
```

展开后显示 `planId`、path 和原始原因。

### 5. 无效输入、存储错误、revdiff 错误、完整性错误

收起状态必须使用 warning/error 语义，不依赖 Pi 默认 success 背景：

```text
● Plan submission failed · storage error
```

展开后显示原始错误、`planId`、revision 和 path（若存在）。

## 历史 transcript 实现原则

Pi 在恢复 Session 时，会按 `toolCallId` 配对持久化的 assistant tool call 与 tool result，并重新调用当前工具的 `renderCall`/`renderResult`。实现应利用：

- `context.args`：读取标题和提交参数。
- `context.state`：在 call/result 两个 slot 间共享最终状态，使批准节点在收起时整体隐藏、展开时重新出现。
- `context.lastComponent`：需要时复用组件，避免闪烁。
- `options.expanded` / `context.expanded`：决定是否显示审计详情。
- `context.isError` 与 `details.kind`：共同决定视觉状态。

渲染不得读取当前 Plan 文件或 review workspace 来补齐历史信息；文件可能已移动、删除，或来自已清理的临时 Session。

## 预期实现范围

已新增：

- `packages/pi-plan-mode/src/tool-display.ts`
  - 解析 call/result 展示数据。
  - 提供 `renderSubmitPlanCall` 和 `renderSubmitPlanResult`。
  - 处理宽度、ANSI、换行和展开预算。

已修改：

- `packages/pi-plan-mode/extensions/plan-mode.ts`
  - 为 `submit_plan` 接入 `renderCall`、`renderResult`。
  - 根据最终视觉方案决定 `renderShell: "self"`。
  - 保持 `execute`、结果 `content` 和审批控制流不变。

已新增测试：

- `packages/pi-plan-mode/tests/tool-display.test.ts`
  - pending、changes requested、approved、keep planning、cancelled、error。
  - collapsed/expanded 两种状态。
  - 历史 Session 数据、不依赖文件系统。
  - annotations 长度预算与窄终端。
  - approved 节点收起隐藏、展开可审计。
  - 主题颜色与 ANSI 宽度安全。

必要时扩展：

- `packages/pi-plan-mode/tests/extension.test.ts`
  - 断言工具注册包含 renderer。
  - 断言现有执行和审批结果未改变。

文档更新在实现完成后再决定，避免当前讨论草案被误写成已发布行为。

## 验收标准

1. `submit_plan` 评审中不再只显示裸工具名。
2. 收起 transcript 保持极简，不重复完整 Plan 或完整 annotations。
3. Changes requested 的历史节点可通过 `Ctrl+O` 查看 annotations 关键内容。
4. Approved 的 `submit_plan` 节点收起时隐藏，展开时可查看 planId、revision、path 和 hash。
5. 取消和错误不会使用误导性的成功视觉。
6. Session 恢复后展示一致，且不访问 Plan/review 文件。
7. Renderer 不修改模型收到的 tool call arguments 或 tool result content；approved handoff 的生命周期扩展由关联计划单独负责。
8. Plan Mode、revdiff、revision、审批、工具恢复及 handoff 测试继续通过。

## 实施决议

- annotations 使用 12 个视觉行预算，超出后显示剩余视觉行数。
- 仅当所有非空 annotations 行都具有 Markdown 列表标记时才报告精确数量；其他格式显示 `Review annotations available`。
- Approved 展开节点显示 Plan ID、path 和 approved hash，不重复 Markdown 大小、Steps 或完整 Plan。
- 使用 `renderShell: "self"` 和 Pi Theme 语义色；渲染异常仍由 Pi 默认 fallback 兜底。
- `ask_user_question` 与 Context7 renderer 不在本次范围内。
