# D3：把脚本内真实执行的子操作放在根调用下面

依赖D2已验收。沿用`docs/pi-tool-display-intent/pi-1.1-integration-plan.md`的W3-B，不进入D4消息样式/导航，不改变工具权限、持久记录、模型输入或计费。

## Goal / AC

一次脚本调用仍是一条顶层工具记录；用户可以看到其实际子操作与状态，不把源码里写过的调用猜成已经执行。

- 复用SDK原生进度/renderer能力；individual保留专用codemode内容，aggregate按根调用归组。不得为统一样式重写整个进度系统。
- live由execution事件及parentToolCallId构建直接父链，覆盖孙调用/并行；稳定调用身份去重，子操作和模型调用不增加顶层工具数。
- codemode details.calls与外层消息nestedCalls是不同数据源/结构。前者提供原生进度，后者用于已有历史；不能拼起来累计，也不能假设renderer的content/details里有消息顶层nestedCalls。
- 成功、部分失败、取消、外层失败分别表达；捕获错误后脚本成功不等于子操作都成功。缺结果正文、缺参数、未结束、complete:false都如实展示，不重执行或读取当前文件冒充历史。
- 沿用D2已有安全快照/缓存，不新建通用框架。至少遵守宿主256calls、单参数8KiB、总参数32KiB记录预算；实际展示可更少。明确单位，先限额再布局/序列化，不伪造精确总数。
- 使用原生durationMs时保持口径；并行不能累加成整轮wall time。nested只是分解展示，不重复计费。HTML仅展示真有的数据，不补造缺失时间。
- 无codemode也能普通使用、阅读旧历史；不自动启用codemode/MCP、不改raw-JS grammar、不增加displaySummary字段。Bash既有fallback保持。

## 第一阶段：只读最小接口交接

先核对精确1.1真实接口，暂不编辑/提交实现：

1. 根renderer/组件怎样通过公开或已有最小ownership取得稳定toolCallId并收到变化；哪些原生能力已经足够，确实还缺哪一层。只定位必要修改点。
2. 真实两/三层native nested的事件、details.calls、最终message.nestedCalls样例形状/时序；分清保存了什么、缺什么，不能用猜测结构的mock代替。
3. 给独立测试作者最小公开fixture入口、状态/计数可观察点与预算单位。优先复用D1/D2测试基础设施，避免新增测试专用生产API。

交接简短，调度冻结后再实施。无需真实模型/MCP；原生codemode可离线合成provider/工具验证。明确实际与未验边界，不以扩大防御协议解决数据缺失。

## 第二阶段冻结的最小接线与预算

只读交接已确认原生进度无需重写。整个本包提供的nested展示遵守预算，不能只限制新增投影而让已知codemode展开列表继续无界：仅对已知原生codemode的details.calls提供有界只读展示副本，继续使用`next()`取得的原renderers及既有D1委托state/lastComponent。原结果、执行、model输入和usage不变；不泛化改写所有第三方renderer。副本省略时明确列表/显示费用仅为部分，不能让裁剪后求和看起来是完整费用。

- 记录和展示最多256个调用、单参数8192/总32768 UTF-8 bytes（compact JSON计量）；先做有界快照再编码/布局。原生details.args仅为200 UTF-16字符预览，不冒充完整原参数；不同预算不能混用。
- 公共context.toolCallId稳定，context.invalidate可刷新同一根；resolver阶段只有toolName，不能在那里猜调用身份。复用现有aggregate/owner清理，非UI/HTML也能取得保存的根元数据，不放入只有hasUI才有的全局指针。
- execution start/update/end都带真实直接parentToolCallId。根execution_end没有nestedCalls，根toolResult message_start已附入，message_end/持久化随后发生。最终记录不能只在execution_end采集。
- details.calls字段id/name/args/status/durationMs/error/cost只含脚本直接工具与models.*；running可能多个条目共享root/?，不得以占位ID、数组位置、名称或参数猜执行身份。自己的工具数/归根只用真实execution身份，模型调用不计工具数。
- persisted nestedCalls为calls:[id,name,arguments?,argumentsBytes?,status:ok|error|unfinished,durationMs?,error?]及complete，包含后代工具、无结果正文/显式父字段/独立模型调用。恢复仅在完整root前缀与确实存在的父记录相符时恢复已知SDK层级；否则平铺/父关系未知，不造祖先。
- codemode明确cancelled可显示；通用error/unfinished不能靠报错文字猜成取消。真实根成功可含失败子操作。个别或全部计时缺失不填零，HTML context.durationMs缺失不补造。

独立作者公共入口：SDK根导出的`createCodemodeExtension({models?:boolean})`放入临时extensionFactories，配fauxProvider；faux ToolCall规范化参数是`{code:rawJavaScript}`，不代表改了grammar。工具通过第五参ctx.executeTool形成真实后代，session.subscribe观察；真实ToolExecutionComponent经updateResult/setExpanded/invalidate观察输出。可复用generic helpers/display-session.ts与AggregateTerminal；AggregateProjection/registerAggregateProjectionEvents及getView/getViewForGroup是现有可观察计数入口。独立作者不读取实施者探针或实现体。

基线事实：三层并行1根+7子/孙，只有一根toolResult，而aggregate live计8、rebuild计1；258次真实调用时native details有258项、nestedCalls为256且complete:false。缺数据如实标注，不为这些正常限制增加另一套进度框架。

## Contract / Test Impact

预留`packages/pi-tool-display-intent/tests/pi11-nested-display.contract.test.ts`，未来独立作者所有。覆盖多层并行归根/只算一次、部分失败/取消、真实保存后的reload/tree/compact/HTML、超限/不完整以及codemode不启用时普通路径。D1/D2独立52例继续保留；不复制已有renderer所有测试。

仅本包相关实现/必要既有测试/双语说明/changeset（第二阶段才可写）；不得改预留独立文件、其他包、SDK/lock、全局配置或统一进度。不得push/main/release。绝对coding/Herdr/worktree/testing规则和SDK相关文档读取要求沿用；主调度为唯一集成者。
