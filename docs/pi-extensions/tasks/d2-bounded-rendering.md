# D2：有界预览与两层布局缓存

依赖 D1 已验收；本阶段只做 W3-A/#148 和展示输入/结构预算，不做 D3 nested 投影或 D4 消息样式/导航，不合并原PR。先交接缓存失效与性能观察接口，再解锁实施。

## Goal / AC

100/300条已完成文本工具历史 warm 后，重复重绘不再完整执行预览布局/高亮和外壳测宽/截断；不能用切换aggregate/summary隐藏性能问题。所有昂贵处理在输入/结构预算之后，真实执行结果与原始产物不修改。

- 两层一起处理：`src/preview-text.ts` 与 `src/tool-call-style.ts`；与 D1 注册owner、renderer-shell、专用renderer状态/清理契约兼容，不缓存或冻结仍在变化的进度。
- 内容修订、宽度、展开状态、主题appearance/有效revision、配置变化正确失效；不得只用对象地址掩盖实际内容变更。主题/配置的可信变化信号按目标SDK证明，不发明不存在的字段。
- 每组件保留有界当前布局；不同历史宽度不能形成无限Map。缓存键不能每帧完整序列化/哈希大结果。
- compact/expanded/error/详情均有预算并明确省略；不能先无界JSON.stringify再截断，不能把展示截断反馈进执行/模型输入/账本。没有真实全文产物时不伪造链接或读取当前文件补历史。
- D1独立21例、HTML共享状态、旧owner与新owner定时器/renderer隔离继续通过。普通模式不依赖codemode。
- 分别记录真实组件重复重绘成本与输入/退格端到端延迟；覆盖regular/fullscreen，明确Linux合成终端与真实Mac验证边界。不用波动的毫秒门槛当单测，不承诺消除所有长历史延迟。

## 第一阶段：只读交接

1. 定位两层实际热点、组件的内容更新/invalidations和已有预算，说明最小缓存位置、生命周期及每组件上界。
2. 给出可验证的内容/主题/配置变化信号，包含in-place更新、resize、展开、partial→final、错误结果和reload；不要因缓存丢失D1委托状态或原生进度。
3. 提供100/300真实组件warm/re-render的可重复离线基准，以及端到端输入测量能覆盖的实际路径。提供独立作者可用的公开组件/输入/观察接口，不新增私有接参API或只读缓存字段断言。
4. 说明预算的数值/单位、各输出路径和截断标记；需要新增产品取舍时先报告。交接后停止，协调者冻结后才实施。

## Contract / Test Impact

T1为失效、生命周期和有界工作量；纯配色/DOM结构不测。独立测试预留 `packages/pi-tool-display-intent/tests/pi11-render-cache.contract.test.ts`（node:test，现有tests/*.test.ts可收集），实现者不写。

| 情况 | 预期 |
|---|---|
| 100/300已完成工具warm后反复render | 不重复完整布局/高亮/外壳处理；保留真实可见文本 |
| 内容、宽度、展开、同appearance不同主题颜色、配置变化 | 该失效条件生效，省略标记/文本正确，不拿旧布局冒充 |
| 重复宽度/多轮resize、对象生命周期结束 | 当前缓存有界，不按历史宽度无限增长或持有其他owner |
| 巨大字符串/结构、异常对象、错误结果、展开详情 | 昂贵遍历/高亮前限制工作量，明确省略；执行结果不变 |
| live进度、partial→final、原生/专用委托 | 不冻结进度或复用错误state/lastComponent |
| reload、HTML、普通模式 | D1语义保持，不启用新runtime/工具、不重执行历史 |

## 写入与交付边界

第二阶段仅Tool Display相关源码/测试、必要双语/包级文档、独立changeset；不改依赖锁、其他包、全局真实配置或统一进度。不得以缓存任务重做消息投影/导航，也不修改独立保留测试。读取全局coding、仓库/Herdr/worktree规则、测试方法论及目标SDK/TUI文档完整链接；隔离PATH/run-isolated，无真实服务。仅本地提交，push/main/release/关闭issue均未授权。
