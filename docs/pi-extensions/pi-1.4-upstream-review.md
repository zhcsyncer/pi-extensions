# Pi 最新发行核查（主会话校订）

核查时间：**2026-10-26 14:54**（本地时区）。目标是`@earendil-works/pi-coding-agent`，不是其它同名包。没有安装或运行1.4，没有修改正式1.2依赖或本机1.3。

## 版本事实

- 官方registry的`latest`是**1.4.0**，本地时间**2026-10-22 06:48**发布。
- 完整registry版本表中，比1.3.0更新的1.x条目只有1.4.0；没有1.3.x补丁。当前dist-tags只有`latest:1.4.0`和`legacy-node20:0.74.2`，没有新的预发布tag。
- 两版公开npm metadata的Node下限均为`>=22.19.0`、TypeBox均为`1.3.27`。CLI的内部SDK依赖分别精确指向对应的1.3.0/1.4.0；这只是发布声明，不等于已验证本仓1.4物理安装图。
- 源仓由npm metadata确认是`https://github.com/earendil-works/pi`。GitHub release也对应v1.4.0。

来源：[dist-tags](https://registry.npmjs.org/-/package/@earendil-works/pi-coding-agent/dist-tags)、[完整registry](https://registry.npmjs.org/@earendil-works/pi-coding-agent)、[v1.4.0 release](https://github.com/earendil-works/pi/releases/tag/v1.4.0)。

## 相对1.3的具体变化

完整官方release正文已经读取，不只取检索摘要。

| 类别 | 1.4.0变化 | 用户影响／取舍 |
|---|---|---|
| 并行脚本 | 进程内codemode worker满时按到达顺序排队；默认两个存活worker，可用`PI_CODEMODE_MAX_WORKERS`调上限 | 不再一满就失败。排队最长60秒，计入脚本`timeout_ms`；无可用worker即不执行。取消中的worker仍占位直到退出。用户可能从“立即报错”变成“等待”，不是无成本提速 |
| 弹窗 | 并发select/confirm/input/editor及inline custom对话框恢复上一层，不再让被替换的第一个Promise永久悬挂 | 多扩展共存直接受益，不必在每个扩展再造一套通用弹窗栈 |
| 长摘要 | compaction/branch summary使用模型输出上限；`generateSummary*`的reserveTokens参数不再限制输出 | 减少reasoning吃光固定额度的失败；也可能产生更长摘要和更多输出费用。compaction.reserveTokens仍控制触发时机 |
| 截断恢复 | 恢复时同时移除被省略的assistant尝试及其对应tool results | 避免工具调用被删、结果残留导致后续每次请求被provider拒绝 |
| 恢复工具集 | 完整重放分支system工具变更，明确移除的工具保持关闭；历史从未提到的新扩展工具按注册默认激活 | 修复后装扩展在resume/tree后掉线。`defaultActive:false`仍关闭；内置工具仍按defaultTools。应核对子任务恢复工具集，但不能据此删除执行权限门禁 |
| 缓存 | OpenAI Responses的deferred tool load在移除工具后不再反复改写请求前缀 | 对对应按需加载路径有缓存/延迟/成本潜在收益；没有本机性能数字，也不是后台cache-warm记账功能 |
| 请求可靠性 | 处理空白工具输出引发的400、更多网关/Vertex OAuth临时错误与Codex代理断流；避免把request id中的数字当状态码 | 直接受益于宿主/模型层修复，不需给每个包增加重试框架 |
| 大请求 | Copilot HTTP413按上下文超限处理；已下线/不可用的Copilot/Codex默认或目录项调整 | 减少图片大请求失败、选到必失败模型；不自动改本仓自定义模型配置 |
| 渲染与终端 | 修CJK相邻粗斜体（含HTML）、未闭合$$吞表格、退出后终端模式残留、Linux复制后Ctrl+Z导致粘贴卡住；支持Rex | 这些是宿主UI修复；不等于已修本地Display的HTML嵌套双视图、共享owner或Glance所有缓存策略 |
| 工具与配置 | grep不再读取RIPGREP_CONFIG_PATH；修正含正则字符的@补全；MCP配置/managed-install的UTF-8 BOM；Windows shell发现 | 缩小环境污染和平台特定失败；不意味着本仓原生MCP授权R3已验 |
| 小型加载修复 | loader暴露`@earendil-works/pi-ai/models`子路径 | 新子路径可用，但已通过compat入口工作的代码不需要为了换import而迁移 |
| 新能力 | classifier支持图片；provider/model级classifier compat；schema生成完整Models Configuration参考；新增MiniMax模型与部分Grok thinking档位 | 可按真实需求使用，不是现有14包必须接入的新功能 |

模型目录的具体变动还包括：Copilot默认改为`gpt-6.1-sol`，NVIDIA改为`nvidia/nemotron-3.5-super-vl-120b-a12b`，Xiaomi两条线改为`mimo-v2.6-pro`；Codex移除对ChatGPT账号不可用的`gpt-5.5`/`gpt-5.3-codex-spark`。xAI的Grok4.3/4.5增加xhigh（不是声称Grok4.7新增了该档）。Workers AI目录将Clef Flash/Jev参考输入价格修为每百万token $0.038/$0.042，Jev不再列免费。这是上游目录/默认值变化，不是本轮改写用户的自定义配置或账单。

权威说明：[coding-agent release](https://github.com/earendil-works/pi/releases/tag/v1.4.0)、[pi-ai 1.4 changelog](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/CHANGELOG.md)、[codemode limits](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/codemode.md#limits)。Context7使用`/earendil-works/pi/v1.4.0`交叉核对排队规则。

## 破坏性变化与本仓实际命中

| 上游变化 | 对本仓检查 | 当前判断 |
|---|---|---|
| `telemetryContext`→`telemetry?:TelemetrySpan`且无别名 | 当前packages/providers的TS源码未发现旧字段直接引用；Fast的旧本地options复制文件已经删除 | 未发现新硬改动落点。反而说明不复制宿主options表有维护收益；不外推为全套1.4运行已验 |
| 删除`getPiUserAgent`旧子路径，改formatUserAgent；User-Agent/归因统一client identity | 当前TS源码未发现旧函数/旧子路径引用 | 无直接迁移命中。Recap另有手写OpenCode headers，后续若利用新identity，应先核会话头与关闭归因语义，不为删几行就提高最低版本 |
| `resolveTranscriptTools`参数和`anchorsAdditions`字段变化 | 当前TS源码未发现直接引用 | 暂无必要适配 |
| before_provider_headers看不到OpenRouter/NIM/OpenCode自动归因头，null删除仍有效 | 当前TS源码未发现该hook | 暂无必要适配，不改认证或端点 |
| extension工具恢复/激活语义修复 | 本仓Subagents按角色授权并收窄可见工具，属于真实相关面 | 值得在1.4做一组resume/tree允许+拒绝正反控；先验证，不先写补丁 |
| codemode worker容量排队 | 未找到本仓Subagents源码中的对应worker容量重试shim | 没有可直接删除的已确认重复实现；`maxConcurrent`和NestedAgentSettlement不是同一职责 |

**不能因SDK修了worker容量，就撤取消结算屏障。** 前者管什么时候能启动脚本，后者管前台嵌套Agent结束前能否落盘根结果与最终用量；没有证据表明1.4替代后者。

## 本轮建议

1. **先享受宿主修复，别扩成新一轮全面重写。** 如果随后决定以1.4为目标，优先离线验证“Subagents恢复工具集/权限”“前台嵌套取消与最终用量”“Tool Display真实执行上下文/对话交互”这些相关路径；不预设每包都要改。
2. **不要为新API存在而迁移。** 当前没有发现上述破坏点的直接源码命中；Node/TypeBox不用另升。Review已用compat的thinking helper，Fast已删除旧配方，不能再编一个shim清理收益。
3. **高收益机会主要已在宿主里**：并发排队、对话框恢复、长摘要/截断恢复、按需工具的缓存前缀稳定。classifier图片与client identity是可选能力，不因版本发布就列必做。

## 核查限制与保留证据

原web研究因轮次限制停止且没有文件工具，无法映射本仓；其估计日期、截断发行说明、以文档未变推导实现未变等部分不采用。主会话直接取官方registry、完整GitHub release、pi-ai完整1.4段与agent-session真实diff，补齐了这部分。

对比API返回81个提交和300个文件，**300是截断边界，不代表全仓只改300个文件**，不能按未列出就认定源码无变化。实际`agent-session.ts`确有工具恢复和截断恢复变更，所以不采用“sdk.md没变，AgentSession就没变”的推论。这里未声称已经逐文件验证所有SDK行为，也没有安装1.4、跑1.4套件或验证真实服务。

本机证据：`/var/tmp/pi-integration-independent-review/upstream-verification/{registry.json,dist-tags.json,release.json,release.md,compare.json,agent-session.diff,ai-1.4.md,verification.json}`。原研究保存在`upstream-original.md`，不作为未经核验的最终结论。
