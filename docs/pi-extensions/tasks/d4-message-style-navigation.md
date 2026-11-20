# D4：普通用户消息样式与宿主导航

依赖D3，范围对应显示规格W4及#150/#151；不直接合旧PR，不改变已验收D1/D2/D3。实施仍在任务专用Herdr工作树，由独立Pi session完成；本文件不是推送/关闭issue/发布授权。

## Goal / AC

新增`transcript.userMessageBox: boolean`，默认true。用户可以关闭普通用户消息的自绘框，回到原生/下游renderer；aggregate steer的折叠、隐藏和分组不受这个开关影响。普通direct工作流无需codemode/MCP。

- 路由先识别aggregate steer，再处理普通消息开关。关闭时保留实际下游renderer的内容/标记/宽度行为，不自行模拟原生输出。
- 自绘路径先去导航标记再布局，最终输出只加一次正确标记并缓存。OSC133 A始终位于首行开头，单行不颠倒；空/隐藏内容保持零行。BEL/ST均识别；cache hit/resize/reload不累加标记，标记不影响可见宽度。
- 可见用户消息保留宿主导航边界；assistant按宿主自身规则，不给带tool call的assistant捏造边界，不侵占其他renderer所有权。
- 清理/重装仅恢复本扩展仍拥有的包装，旧session不能拆掉新包装，也不能覆盖中途安装的其他用户消息renderer。
- 设置从schema、读取/规范化/保存到`/tools`面板、示例和双语README接通；省略字段默认true，明确false持久化后reload仍有效。非法输入按现有配置策略处理，不新建迁移/设置框架。

## Design

完整意图见`docs/pi-tool-display-intent/pi-1.1-integration-plan.md`的W4。优先复用SDK1.1已有路由/导航能力和本包已有owner/caching机制，只保留确无公共替代的最小包装。不是增加多视觉主题、重写问卷编辑器/全局TUI或普遍移除所有prototype patch。

已定位`user-message-box-native.ts`的isEnabled硬编码true；`user-message-box-renderer.ts`先检查isEnabled再处理steer，最终cache未恢复宿主标记；`user-message-box-patch.ts`无条件恢复旧render，可能覆盖新owner/第三方包装。配置优先把公开`transcript.userMessageBox`映射到已有effective `enableNativeUserMessageBox`，避免两个互相覆盖的布尔开关；只改内部布尔值而不接通配置/UI不算完成。修复路由次序、最终标记与明确owner身份/包装函数引用即可，不新加无用户收益的权限/通用中间件。

## Contract / Test Impact

独立预留：`packages/pi-tool-display-intent/tests/pi11-message-navigation.contract.test.ts`。作者可读SDK公共声明/文档与generic fixture，不读待测实现或作者测试；需先收到公共导出和UI操作事实，不能猜私有字段。

| 场景 | 预期 |
|---|---|
| individual/aggregate × 默认/false | 普通用户消息样式按偏好；steer行为不变 |
| 真设置面板保存false并reload；恢复true | 真实历史/新消息走当前偏好，不手工调用invalidate冒充设置接线 |
| 原生/合作renderer passthrough | 其输出保持，不再加第二份导航标记 |
| BEL/ST、单行、多行、隐藏/空、cache hit、resize | A行首，边界唯一，去标记后可见文本/测宽不变 |
| assistant纯文本与含tool call | 跟随宿主规则，不自造工具批次消息边界 |
| owner重装/旧owner清理/第三方新wrapper | 只卸载自己仍拥有的包装，无跨session破坏 |

以真实SDK UserMessage/Assistant组件、真实extension注册和TUI fixture为主；可对纯marker变换补精确T1单测，但不能全部用helper绿代替接线。行为测试不锁偶然DOM/内部字段。无需真实模型服务；Linux组件/合成终端检查不声称完整CLI/PTY/Mac键盘验收，后者留L1。

实施者只改本包必要源/自有测试/配置/双语文档及独立changeset，不读写D1/D2/D3及本任务预留测试。完整包check/types、既有三个独立合同、loader/pack与必要离线UI检查通过后，交固定候选独立审阅。原始数据、执行和费用语义均不变。
