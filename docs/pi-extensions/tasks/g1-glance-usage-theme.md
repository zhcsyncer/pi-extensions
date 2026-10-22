# G1：Glance 已记录用量与主题 appearance

## 当前授权：主题边界与真实生命周期核查（2026-10-22）

三模型/顾问后用户授权：保留核心用量、未知标记、appearance判定及默认缓存键配套，不裁剪两个Set；仅恢复显式手动cacheKey的原覆盖语义，并增加真实工作动画路径的独立回归。pi/glance色源均需验证稳定同名主题在活跃周期内翻转明暗会更新帧、同明暗不反复安装；UI/时钟/稳定主题代理可为替身，不冒称真实TTY或系统通知验收。同明暗换palette不在修复范围。

新独立文件预留`packages/pi-glance/scripts/test-pi12-working-appearance.ts`，作者只看合同和公开接口，不读实现或其它作者测试。实施者不读改新文件及原独立14项；协调者负责将新独立脚本加入正式runner，保留旧独立入口。

另核实SDK1.2/1.3真实exit/reload/switch流程是否向已shutdown的同一实例再投递agent_end/settled。不能凭人为拼接shutdown→agentEnd测试失败就修改生产；只有可达或明确支持的契约且确有重复累计才最小修正。通用快照异常恢复仅记录，不扩框架。

已批准的compact USD说明删除保持；费用/分项/零值显示、Git/diff逻辑和真实配置本次均不改。基线为f9b91dc，依赖目标仍1.2；授权后需复验当前同字节源码在实际1.3的行为，不能借早于说明行删除的旧快照充数。

交付4218647：生产仅两行修改，原独立14与双Set保持。新主题独立合同原1红2绿，恢复手动覆盖后3/3；完整check仅补新测试的精确架构登记，不放宽生产限制。真实SDK1.2/1.3各六场景通过异步observer固定正常公共入口的通知/清理重叠，证实同一旧实例在shutdown后仍收agent_end/settled、内存费用2→4；持久JSONL始终2、新实例费用正常。零进度改为重建后原交错仍发生，旧内存2→2，12/12通过；原探针/失败与基线日志哈希保全。正常串行关闭与该交错区分，未执行真实TTY/信号退出，不把内存修正说成重复扣费修复。

当前同字节源码在实际1.2/1.3均完整check通过（含类型、旧14与新3），注册loader、pack17/policy通过。本次环境有revdiff，原生临时配置验证及--dump-config集成实际通过，但不代表交互diff/TTY验收。独立依赖安装的断网策略校验超时、缺测试白名单和两个初始生命周期夹具错误均另留，不当产品失败。证据：`/var/tmp/pi-glance-boundaries/`。

依赖已验收R1/M1。只做W7-C用量和W9主题/必要显示兼容；B01大粘贴、working/Git/stash体验不扩展。禁止把显示适配变成新账本、跨会话证明或轮询框架。

## Goal / Design

已定位runtime-snapshot.ts忽略独立type:usage；runtime-refresh-session.ts按responseId/对象记message_end增量，不能代替持久entry身份；theme-tone.ts只按名称认明暗，theme-adapter.ts的缓存键也缺appearance。

- 独立usage（包括未知kind）计入已记录费用/对应token桶，且不进入模型上下文或推理生成/速度统计。assistant、外层toolResult汇总及需要计入的summary各计一次；nested执行事件不另加，不扫描子日志重复父rollup。
- 使用SDK稳定entry.id与公开持久化边界，两个entry即便payload/responseId相同也分别计入；同一entry被重复观察不再加。startup/reload与live、tree/compact后重建口径一致。
- 保留当前getEntries全session已记录累计口径，不擅改成只算当前branch；getBranch仍用于context/compaction判断。新session清空本session身份，不新做跨文件全局去重。
- 启动允许一次全量；之后只处理新增记录，必要的tree/reload断点可重建。turn_end/agent_settled/已有配置与生命周期边界同步已持久记录；不注册并不存在的pi.on(entry_appended)，不每帧遍历/序列化历史、不新增idle网络/历史轮询。idle新增usage最迟在下次这些公开边界反映，不承诺无公共事件的瞬时刷新。
- 不用早期message_end猜持久entry身份，不为旧假夹具缺id添加生产兼容框架；必要更新旧fixture顺序，使之符合真实SDK消息持久化后再观察。
- 保留已知费用小计；真实缺失/无效cost不能伪装确认0，可用最小unknown标记表达，明确当前session已记录口径。不加历史迁移或新收费推断；未记录旁路费用不猜测。
- 优先公开theme.appearance判dark/light，缺失时才保留原名称fallback；同名system/同对象appearance变化须让实际可见样式与缓存失效。不依赖不存在的revision、不重写主题系统。

## Contract / Test Impact

独立预留`packages/pi-glance/scripts/test-pi11-usage-theme.ts`。沿用本包编译型script测试机制；独立作者还获准仅在package.json的test:dev末尾追加该编译脚本调用，使正式check包含它，不改其它manifest字段。实现者不可读写该文件或独立runner变更；实现者可单独改engines字段对齐SDK>=22.19.0，不改版本/锁，两者不同区域。

| 场景 | 预期 |
|---|---|
| assistant .01 + outer .03 + usage .02 | 已记录小计.06；nested分解不叠加 |
| 相同payload/responseId、不同entry IDs；重复观察 | 不错并两笔，也不重复加同一笔 |
| 已有历史后继续live，重复边界，reload/tree/compact | 和持久记录快照一致，不把历史再加一次 |
| 未知kind、cache_warm、缺cost与明确0 | 新usage计入对应桶且unknown可辨，不增加生成速度/上下文 |
| 反复render/resize/theme刷新 | 不触发历史重扫；公开边界同步后状态正确 |
| appearance优先/缺值fallback/同名system明暗变化 | 可见选择和实际缓存刷新，不只断缓存key字符串 |
| 原working/Git/stash及输入 | 原回归保持；大粘贴增强不做 |

## 公共夹具

SDK SessionManager.appendUsage(kind,provider,model,usage,note?)返回带id的UsageEntry；appendMessage/appendCompaction等也用公开入口。真实registry/session及公开事件作为持久化/生命周期正控，不手改私有usage字段。

本包可导入执行的公共边界：runtime-snapshot.ts的usageTotalsFromSessionMessage、usageTotalsFromEntries、stateInputsFromContext；theme-tone.ts的readPiAmbientTone；theme-adapter.ts的resolvePiThemeStyles/resolveGlanceRenderStyles；runtime.ts的createGlanceRuntime(adapters)及其events方法。类型用公开type-only/Parameters/ReturnType，不读实现体。

允许读取scripts/runtime-harness.ts与surface-test-harness.ts泛用基础设施（有getEntryReads/getBranchReads及真实表面factory捕获），但不能把纯mock状态等同真实SDK证明。精确签名缺口直接向协调者报符号，不弹用户审批或读实施者测试。网络与外部Git/mux副作用用已有适配边界阻断，只在隔离临时环境操作。

交付只本包必要源、自有回归、双语README/包级docs/单独changeset及授权manifest区域；目标SDK1.1/TypeBox1.3.27。实现完整check/types/loader/pack；独立baseline分类；固定组合审阅和集成复验后验收。不推送/main/发布，不改真实profile或其它包。
