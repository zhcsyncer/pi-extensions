# C1：Consult 改用 Pi 公开 SDK，保持顾问调用契约

执行合同；依赖 E0 已验收。实际进度仅在执行编排 §0 更新。

## Goal / AC

用户已明确将此项纳入适配：不再探查 Pi 内部对象来调用顾问，改用目标 Pi 1.1 明确对扩展公开的 SDK 入口，同时保留现有账号/订阅渠道和顾问行为。这里的“公开”不是改接模型厂商 HTTP API，也不是新增顾问功能。

1. 以目标 SDK 的真实公开调用面替代 `getRuntimeStreamSimple` 对 modelRegistry.runtime 的探查；只支持 1.1+，不保留无必要的旧宿主探测分支。不能仅以成功 import 或 mock 返回成功证明认证等价。
2. 现有物理顾问模型、provider、账号/订阅、OAuth 凭据派生的 baseUrl/headers 等继续生效；缺失/错误配置明确失败，不静默改用付费 key、另一账号或通用 OpenAI endpoint。
3. 工具注册采用 model-only：普通直接调用可用，nested 工具调用不能启动顾问请求。不开 codemode 的使用仍是正式路径；不擅自开启/更改用户工具模式。
4. watchdog 首期只统计顶层工具事件，nested 子事件不与 outer 重复计数，也不因忽略 nested 而漏掉 outer。Consult 自身、预算、触发锁与下一轮重新累计等原规则不变。
5. 顾问请求保持独立 system prompt、tools=[]，不继承父执行权限；why、当前 consult 的上下文剥离、用户图片、采纳/tree/reload、取消/重试及费用汇总行为不新增回归。
6. 保留真实请求前的预算原子占位及 fanout/失败/取消的既有语义，不因等待认证/请求并发而超预算；不要为迁移引入新的上下文协议、虚拟路由或旁路费用框架。

## Design / 具体变更边界

已定位当前调用链：`packages/pi-consult/src/pi-compat.ts` 探查 private runtime 并兼容两种 import；`src/execute.ts:396` 选择 opts.streamSimple/runtime fallback，随后通过 getApiKeyAndHeaders 预检，runConsultPanel 的 useRuntimeFacade 分支决定是否显式带 key/headers。该分支原本承担认证字段保真，不能将其当死代码直接删掉。

实施前先核验目标 1.1 的公开注册表/流式入口能否保持上述语义，并把选中的接口、参数归属与离线可观察证据写在交付说明；有明确等价入口则最小替换，无等价入口则报告具体阻塞，不自行降级认证。保留已有测试注入边界可以，但生产路径必须经过真实公开 SDK，不能用 opts.streamSimple 的测试替身冒充迁移完成。

`extensions/consult.ts` 当前在 tool_execution_start/end 均无父层过滤，注册工具亦需明确曝光边界；在事件接入层过滤 nested，尽量不改 tracker 状态机。既有 panel、watchdog、预算、adoption 与 UI 继续复用。

允许写 Consult 包的上述适配、直接受影响调用方、测试、必要双语用户说明及独立 changeset（按 bundle 规则含 root）。不改 manifest/lock、其他包、总计划/进度、全局配置或真实 auth。Executor-context proposal、虚拟模型/自动分流、顾问多代理化和命令体验改善均不在本项。

## Contract / Test Impact

T2 为 SDK 调用/认证/事件接线，T1 为工具调用边界、watchdog 层级与预算。编码前核对现有测试对合同的覆盖，只补真实缺口；不为公开方法直线透传凑 mock 自证测试。

| 场景 | 可观察结果 |
|---|---|
| 真实公开 SDK＋离线 API-key provider | 请求落到指定物理 provider/model，保留显式选项与取消信号；不通过私有 runtime 探查 |
| 真实公开 SDK＋合成 OAuth/凭据派生 endpoint 和 headers | 实际 provider 接收的 endpoint/headers 与预期认证身份一致，不退回默认 endpoint 或另一个渠道；无需真实凭据/网络 |
| 不完整认证、无可用模型、SDK 请求失败 | 返回既有 blocked/failed 工具结果，不砸会话、不切渠道；保留有意义错误 |
| 顶层直接 consult 与 nested consult | 前者正常；后者由实际注册/执行边界拒绝且顾问请求零次，不仅断言 exposure 字符串 |
| 一个 outer 内多个 nested 工具事件 | watchdog 只观察 outer 一次；nested 次数不能提前触发阈值，outer 自身仍计数 |
| 相同顶层调用/错误达阈值、Consult 自身事件 | 沿用现有触发规则；Consult 不自触发，完成后需重新累计 |
| 认证等待时另一调用抢占剩余预算 | 请求前重新检查并原子预留，不超预算；无需发真实请求证明 |
| 父上下文包含工具定义/图片/current consult，或 tree/reload | 顾问 tools 仍为空，当前调用正确剥离、图片保留、采纳状态按原会话分支关联 |
| cancel/空响应重试/fanout | 不在取消后新发请求；现有重试和已上报 usage 聚合不新增重复或漏记 |

测试用假 provider、内存凭据、隔离 agentDir/HOME 和实际 SDK 调用链；不允许真实模型请求、账号登录或新开付费渠道。执行路径/认证的集成测试应观察真正传给 provider 的参数，而不是断言自制 wrapper 返回自己的固定值。

实现者不改保留文件 `packages/pi-consult/tests/pi11-public-sdk.contract.test.ts`；该文件由独立测试作者按本合同补充真实 SDK/认证与层级边界用例，在 R1/D1 测试交付后串行使用额外测试槽位。实现者可维护已有测试，但交付需给出已选公开接口/fixture 接线事实，不能让独立作者读取新实现猜预期。代码可先交付，未组合通过独立测试前不完成验收。独立审阅将核验真实 SDK 路径与行为测试；接口事实不足或新增规则超出合同则先交调度者处理，不悄悄扩容。

## 派发与交付

读取适用规则绝对路径 `/root/.agent-vm-state/pi/agent/AGENTS.md`、`/root/.agent-vm-state/pi/agent/rules/coding.md`、`/root/develop/AGENTS.md`、Herdr/worktree 的 AGENTS 与本任务 worktree AGENTS；完整读本合同、Consult 已落地说明、总计划范围和目标 SDK 相关文档/交叉引用。先确认 cwd/origin/base/写范围再编辑。

使用已经验收的独立依赖，`PATH=/var/tmp/pi-e0-target/bin:$PATH`，通过 `scripts/run-isolated.mjs` 运行适用检查。不改 SDK 基线。交付本地 commit、公开接口与认证等价证据、实际测试结果/未验证边界；不 push/main merge/release，不编辑统一进度表，不另外派实施者。
