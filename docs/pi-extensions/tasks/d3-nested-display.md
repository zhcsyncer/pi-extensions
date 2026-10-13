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

## Contract / Test Impact

预留`packages/pi-tool-display-intent/tests/pi11-nested-display.contract.test.ts`，未来独立作者所有。覆盖多层并行归根/只算一次、部分失败/取消、真实保存后的reload/tree/compact/HTML、超限/不完整以及codemode不启用时普通路径。D1/D2独立52例继续保留；不复制已有renderer所有测试。

仅本包相关实现/必要既有测试/双语说明/changeset（第二阶段才可写）；不得改预留独立文件、其他包、SDK/lock、全局配置或统一进度。不得push/main/release。绝对coding/Herdr/worktree/testing规则和SDK相关文档读取要求沿用；主调度为唯一集成者。
