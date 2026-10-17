# Pi 1.x 升级与扩展取舍评估（更新至 1.1.0）

状态：**审计记录；仅完成研究、代码审阅与隔离验证，未实施适配或升级宿主。**

**现行实施入口：[Pi 1.1.0 全扩展适配与待办整合计划](./pi-1.1-implementation-plan.md)。** 2026-10-10 已结合全部开放 issue/PR 与 BACKLOG 重新规划；用户确定使用 codemode、暂不使用虚拟模型/tool_search、Context7 转原生 MCP。最新全局配置已排除 worktree Plan 与 Junie，以下“活动来源”仍是原审计当时的快照，不代表当前启用状态。历史验证数字不变。

首轮审计：**2026-10-02**；1.0.2 复核：**2026-10-04**；最新复核：**2026-10-08（北京时间，UTC+8）**。

当前目标版本：**`@earendil-works/pi-coding-agent@1.1.0`**，已直接向 npm registry 确认 `latest`。本仓库根扩展包仍为 `@zhcsyncer/pi-extensions@1.0.2`；正在运行的 Pi 宿主仍为 **0.87.1**。

阅读范围：首轮 1.0.0 实测保留在 §7，1.0.2 历史增量保留在 §10；**最新 1.0.3 / 1.0.4 / 1.1.0 增量与复核见 §11**。摘要/矩阵已同步，旧测试没有改标为新版通过。

源码基线：`zhcsyncer/pi-extensions`，`main@f48a91b8366174f2ece5d393e280641be87fbb70`。

## 结论先行

**值得升级，但不建议把“升级 Pi”“全面启用 codemode/MCP”“开启自动模型路由”合成一次切换。** 对当前环境，最重要的不是默认全屏，而是工具从“模型直接调用”扩展到“工具内部再调用工具”之后，原有权限、状态保存、显示和费用统计的假设发生了变化。

1. **不是大面积加载失败。** 在首轮隔离的 Pi 1.0.0 中，22 个仓库/实际安装入口的加载与 factory 调用均无异常；其中两个 Herdr 入口走未启用的 no-op 分支，不能视为活动注册路径已验证。这也不代表生命周期、真实请求和恢复都通过。
2. **有确认需要修的兼容问题。** Subagents 的 steering 返回类型/回执、工具展示层的 Bash 结构化输出与 nested 聚合显示，以及部分会话恢复契约，需要适配。开启 codemode 后，还必须处理子代理工具权限与 Todo 等工具的持久化边界。
3. **实际安装比仓库更复杂。** 活动 Plan 来自另一 worktree；Review 的 external 路径可使用 bundle 内 Subagents `0.2.3`，embedded fallback 却解析到独立安装的 `0.2.0`。只修改 main、只更新根包，不能证明实际环境已适配。
4. **没有证据支持整体废弃大多数扩展。** 截至 Pi 1.1.0，仍没有内置本仓库这些完整的 Todo、Plan、问卷、子代理、顾问、对抗审查、搜索聚合、订阅额度或 Herdr 工作流。原生耗时、留白和终端状态扩大了局部去重空间，不等于整包替代。
5. **最值得试点替换的是 Context7 的自维护连接层。** 原生 MCP 可以接管其服务连接；skill、鉴权迁移、工具名和展示差异仍要处理。工具展示/Glance 的部分重复底层实现也适合收缩，而不是直接删除整包。
6. **暂不建议把虚拟模型 auto 设为长会话默认。** 1.0 仍只提供路由机制，不提供质量保证；当前扩展还存在“所选虚拟模型”和“实际执行模型”混淆，以及旁路调用不能路由的问题。

**1.1.0 最新结论：旧核心风险仍在，新增工具选择语义与测试适配要求。** 类型检查从 1.0.2 的 **14/16** 变为 **13/16**：新增失败是 Tool Display 测试终端缺少 `setProgramStatus()`，不代表生产 UI 已坏。Fast 的档位采样覆盖问题仍在，且本地 4 字符/token 估算没有跟进官方的 3.5。CLI/SDK 的非空工具白名单现在可保留 MCP 注册，不能再当作完整授权边界。原生 `durationMs`、`outputPad`、OSC 7501 可减少部分自维护逻辑，但不自动修复聚合、持久化或 Herdr 会话关联。

### 建议的 review 决策

- **先做小范围兼容升级**：保持当前物理模型、工具调用方式与 UI 配置，修复确认问题并收敛实际依赖版本。
- **第一轮 codemode 接入保持状态/交互/编排工具顶层专用**：优先评估 `model-only`，不为了“可编程”而改变已有恢复、审批和审计契约。
- **只先试点 Context7 连接层替换与 UI 底层去重**：不批量退役扩展，也不同时重构整个工作流。

---

## 1. 审计范围与真实基线

### 1.1 版本并不统一

| 层次 | 实际情况 | 对结论的影响 |
|---|---|---|
| 正在运行的 Pi CLI | **0.87.1**，2026-10-08 复核未变 | 当前计划升级跨度是 `0.87.1 → 1.1.0` |
| 主仓库开发依赖 | Pi AI / Coding Agent / TUI **0.86.1** | 现有测试通过不能直接证明 1.0 兼容 |
| Node / pnpm | Node **24.21.0**；pnpm **11.11.0** | 满足 Pi 1.0 的 Node `>=22.19.0` 要求 |
| 根扩展包 | `@zhcsyncer/pi-extensions@1.0.2` | 这是扩展集合版本，不是 Pi 宿主版本 |
| 活动 Plan | `feat-plan-mode-subagent-explore@de32f84`，包版本仍为 `0.3.1` | 与 main 同版本号、不同实现；该 worktree 的开发 SDK 是 **0.84.0** |
| Review 的独立依赖 | `@zhcsyncer/pi-subagents@0.2.0` | 与根 bundle 的 `0.2.3` 不同，见 §4.2 |
| Junie bridge | `1.3.2`，`42f4d73` 加用户未提交改动 | 结论针对当前工作副本，不能只按 npm/HEAD 推断 |
| 当前主题/模式 | 显式 `theme: "dark"`、`tuiMode: "fullscreen"` | 新默认值不会覆盖这两个显式设置 |
| 当前原生 MCP/codemode | `defaultTools` 未设置；全局及当前项目无 `mcp.json` | 本次配置没有因 MCP 自动激活 codemode；新能力风险不应写成当前已发生故障 |

内置 dark/light 的色板本身也在 0.99.0 调整过；保留 `dark` 名称不表示所有颜色逐像素不变。

仓库来源已通过 `git remote get-url origin` 确认：`git@github.com:zhcsyncer/pi-extensions.git`。Junie 来源为 `git@github.com:zhcsyncer/pi-jetbrains-junie-bridge.git`。

### 1.2 实际加载来源

- 根 bundle 12 个扩展入口中，**Plan 入口被排除**；由上述 worktree 的 Plan 替代。
- Herdr Companion、Adversarial Review 为独立安装包，不是根 `pi.extensions` 自动启用项。
- 另外启用 Junie bridge、Ollama Cloud、Volcengine Agent Plan、Cursor Ask，以及全局 `extensions/herdr-agent-state.ts`。
- `pi-wtf`、`pi-context-view`、`pi-mono-figma` 的扩展入口在配置中被排除；`moshi-hooks.ts` 也被排除。本次不把它们当活动运行路径展开审计。
- `feat-pi-psql` 是 skill 包，配置排除了其 `SKILL.md`；它不是本次需要适配 SDK 的代码扩展。

对根 bundle 与 main 的已安装运行源码做了文件比对：本次比对的 TS/JS/JSON 实现文件一致；独立 Herdr/Review 实现也一致，manifest 有打包差异。**依赖解析仍必须单独检查**，Review 的 `0.2.0` 就是这个比对不能覆盖的部分。

### 1.3 证据分级

- **实测**：精确 1.0 loader、差分类型检查或本地确定性探针已复现。
- **契约确认**：完整相关源码与 1.0 文档/实现构成明确证据链，但未跑真实端到端场景。
- **条件适配**：仅在启用 codemode、原生 MCP、虚拟模型或新登录方式后触发。
- **待回归**：有明确风险点，但不宣称已经损坏。
- **既存问题**：升级前已经存在，单独列出，不冒充 1.0 新回归。

---

## 2. Pi 1.0 到底带来了什么

### 2.1 先区分“1.0 发布宣传”与“这次新增”

官方 changelog 的序列是：

```text
0.87.1 → 0.99.0 → 0.99.1 → 0.99.2 → 1.0.0 → 1.0.1 → 1.0.2 → 1.0.3 → 1.0.4 → 1.1.0
```

中间没有要逐版迁移的 `0.88–0.98`。1.0.0 GitHub Release 发布时间为 **2026-10-02 03:20（北京时间）**；changelog 标注发布日期为 `2026-10-01`。

1.0 博文集中介绍 codemode、MCP、虚拟模型、延迟工具发现、cache warming、会话中的系统消息更新、主题和全屏。但 **cache warming 与 transcript-aware prompt/tool updates 在 0.86.0 已落地**，当前 0.87.1 已有，不能算成这次才新增的能力。

### 2.2 按用户价值排序

| 变化 | 首次/主要版本 | 具体场景 | 对你的优先级 |
|---|---|---|---|
| 原生 MCP + codemode + 按需工具发现 | 0.99.0；0.99.2/1.0 加固 | 跨服务查询、批量调用、程序化过滤中间结果 | **高**，但应在嵌套调用适配后分批启用 |
| 工具结构化输出与嵌套执行契约 | 0.99.0 | 一个工具组合多个工具，保留校验、权限 hook、事件与费用 | **最高**，直接碰到现有扩展假设 |
| 长会话性能改进 | 0.99.0–1.0 | 长历史、持续流式输出、大消息渲染 | **高**，不需要采用新工作流即可受益 |
| 虚拟模型 | 0.99.0 | 每次请求按策略选择真实模型/思考级别 | **中，先实验**；目前不宜长会话默认 |
| 分类模型及图像生成统一运行时 | 0.99.0；1.0 加入 codemode 生图 | 文本分类、筛选、评分、图片生成 | **中**；按实际需求采用，不是升级前置条件 |
| ChatGPT 登录、OAuth 改进 | 0.99.0–1.0 | 使用订阅、远端机器登录、MCP 多账户 | **中高**；旧 Codex 渠道没有直接消失 |
| system 主题、默认全屏 | 0.99.0 / 1.0 | 与终端配色统一、原生滚动/搜索/选择 | **当前较低**；你已显式 fullscreen + dark |
| Pi Durable 独立实验包 | 1.0 同期发布介绍 | 构建多入口、长时运行 Agent 应用 | **观察即可**；不是当前扩展迁移目标 |

### 2.3 Codemode/MCP：1.0 比最初 0.99.0 更成熟的地方

- 0.99.2 起，默认 codemode exposure 的 MCP 服务器不阻塞第一条 prompt；按需等待连接。
- 工具发现改用 `searchTools()`、`describeNamespace()`；工具描述不再随服务器连接数量变化，减少无谓的提示前缀变化。
- `codemode-deferred` 已成为 `codemode` 的别名，不应继续以 0.99.0 的旧模式划分设计配置。
- MCP 名称中的 `-` 归一成 `_`；工具名冲突有专门处理。迁移硬编码工具名时要核验最终注册名。
- 1.0 精简 codemode 提示。官方示例中，GPT-5.6 + 默认工具从约 **5,300 降到 3,300 prompt tokens**。这是该示例的测量，不是本扩展集合可直接承诺的降幅。
- 1.0 的错误更便于模型恢复：未知成员提示相近名称；未知模型提示枚举可用模型；参数形状错误给出预期格式。
- 不存在的 `tools` 成员现在抛错；存在性检查应使用 `"name" in tools`，不再依赖 `typeof tools.name`。
- `models.generateImages()` 可在脚本内使用会话认证，费用和分类调用一样计入外层 codemode 工具结果。
- 修复 deferred MCP 工具在 resume/reload 后丢失的问题。

**仍然要保留的边界：**codemode 的优势是复用 Pi 工具/模型运行时，不是 Python/Bash 做不到并行和过滤；QuickJS 沙箱也不意味着工具调用具备操作系统级隔离。

### 2.4 嵌套调用是本次最重要的契约变化

1.0 的调用关系是：

```text
模型 → 顶层工具（例如 codemode）
          └─ ctx.executeTool() → 底层工具
```

底层调用仍经过参数校验、`tool_call`、`tool_result`，并发出 execution events；事件带 `parentToolCallId`，ID 类似 `outer/1`。

但它们 **不各自形成独立 transcript toolResult**。外层结果上保存的是有界 `nestedCalls` 元数据，不保存嵌套结果正文。嵌套用量自动合并进外层 usage。

这意味着：

- **依赖顶层 toolResult 恢复状态的工具不能直接开放嵌套调用。**
- **只拦截低层 `agent.beforeToolCall`，不等于拦住 session 的 nested pipeline。**
- **显示层不能假定每个 execution event 都对应一个独立 TUI 工具组件。**
- **计费不能既累计 nested event，又累计外层已汇总 usage。**

工具曝光也不再只有“开/关”：`direct` 默认同时允许模型和其他工具调用；`model-only` 仅供模型顶层调用；`codemode/deferred` 可以在没有直接向模型声明时仍供程序化调用。`setActiveTools()` 不是完整权限模型。

### 2.5 登录、性能及其他值得关注的变化

- `/login openai` 支持 ChatGPT 订阅；`openai-codex` 仍存在，只是显示为 legacy。不要把显示名变化当 provider ID 已删除。
- 1.0 新增 Anthropic copy-code 登录，适合浏览器不在运行 Pi 的机器上。
- Radius 可在登录后辅助配置其 MCP；不等于所有用户都需要 Radius。
- MCP OAuth 加入 RFC 9207 issuer 校验、授权服务器 metadata override；追加 scope 时保留既有授权；凭据按 server name + URL 隔离。
- 1.0 修复 `--provider` 未配 `--model` 时静默使用别家默认模型的问题：现在报错，脚本应显式选定。
- `quietStartup: "header"` 可以只保留版本/快捷键头部。
- 长会话提交变慢、目录合并、流式 CPU 开销和渲染缓存有优化；1.0 官方示例中长 assistant 消息保留的堆内存约为此前的五分之一。**不是本机测得整个 Pi 进程内存下降 80%。**
- 首条用户消息即建立 session 文件，避免首个 assistant 响应前退出导致新会话丢失。

### 2.6 虚拟模型：之前讨论的限制没有被 1.0 自动解决

1.0 的机制仍是 `route(request, ctx) → { model, thinkingLevel, state? }`。路由状态随会话分支保存；所选虚拟模型与实际 assistant 使用的物理模型是两种身份。

发行包中的 `examples/extensions/jev-router.ts` 仍是：首次用 Jev 判普通/复杂 → 选规划模型 → **第一次成功的顶层 `edit/write` 后切到 Luna，并保持该阶段**。它不是持续判断任务变化的通用 auto；脚本内 nested edit/write 也不是该示例目前检查的独立 toolResult。

1.0 发布博文的视频是现场生成另一个路由扩展的演示，不应与发行包中的固定示例、内置默认策略混为一谈。

因此：混模型的理解漂移、能力降档、缓存失效及小窗口触发压缩等权衡仍然存在。技术上能重放会话，不等于质量无损。此处没有做多模型质量 benchmark，不作效果保证。

### 2.7 真正的 SDK breaking changes，哪些命中了本仓库

| 上游变化 | 本仓库情况 |
|---|---|
| 1.0 `pi-agent-core` 移除实验 `AgentHarness`、`./node`、`./harness/*`、pico3 等 | 审阅的活动执行核心未使用这些接口；**没有理由为此迁到 Pi Durable** |
| 0.99 图像模型集合统一，旧 `ImagesModels/createImagesModels` 等移除 | 未发现相关活动调用需要迁移；聊天读取仍保留聊天语义 |
| `ProviderModelConfig` 变为 chat/image/classifier 联合类型 | **Ollama Cloud 两处索引类型命中**，见 §4.9 |
| TUI 删除旧 terminal color query 方法 | 未发现本仓库活动代码直接调用被删方法；Glance 的问题是自身主题识别假设 |
| `steer/followUp` 返回 input disposition | **Subagents / 由其源码参与构建的 Review 命中** |
| 内置来源统一为 `builtin:<name>`；`--no-extensions` 也禁用内置扩展 | 子代理/显式加载器接入新内置能力时必须处理；不是所有现有 child 都已失效 |

---

## 3. 逐包处置矩阵

“保留”不等于“已验证所有 1.0 行为”；“条件适配”不等于当前默认配置已经损坏。

### 3.1 本仓库维护的包

| 包 / 当前版本 | 必要或重点工作 | 原生替代判断 |
|---|---|---|
| `pi-tool-display-intent` **0.10.1** | renderer/语义装饰分离、Bash 契约与 nested 聚合；新增测试 Terminal.setProgramStatus 适配，评估 durationMs/outputPad | **保留；可缩减完成耗时估算和纯边距，不可整层删除** |
| `pi-subagents` **0.2.3** | steering、nested scope、恢复与费用水位；复核 SDK MCP 白名单豁免与内部取消的 aborted 归属 | **保留**，codemode 不是独立子会话 |
| `pi-adversarial-review` **0.1.1** | 与 Subagents 同步；修安装依赖漂移；虚拟 reviewer 的独立性/实际路由策略 | **保留**，原生无等价审查协议 |
| `pi-plan-mode` **0.3.1** | 以活动 worktree 为准；submit/complete 顶层专用；新工具仍默认 fail-closed | **保留**，虚拟模型阶段路由不替代审批与计划生命周期 |
| `pi-todo` **0.5.1** | codemode 前解决 checkpoint 只依赖顶层结果的问题，首选评估 model-only | **保留**，普通 checklist/example 不替代周期不变量 |
| `pi-ask-user-question` **0.1.2** | 建议 model-only；回归真实 TUI/RPC/取消 | **保留**，基础 select/input 不是 rich 问卷的等价替代 |
| `pi-consult` **0.1.1** | 建议 model-only；虚拟身份、watchdog 层级、公开 stream API | **保留**，分类器不是带理由的独立顾问 |
| `pi-glance` **0.9.2** | system theme appearance/cache；虚拟实际模型展示；独立 usage entry | **保留或缩减 segments**，Git/stash/working 行仍有价值 |
| `pi-meter` **0.4.4** | 独立 usage entry；nested 子代理汇总防双计；模型归属 | **保留**，原生 session 总账不替代跨会话账本/套餐窗口 |
| `pi-fast-mode` **0.2.1** | 透传 stream hook；同步 1.1.0 的 3.5 字符/token 估算；档位采样三层合并错误仍需修 | **保留并瘦身**，原生 service tier 不替代开关与策略 UI |
| `pi-recap` **0.4.3** | 使用虚拟模型前迁移调用路径；区分旁路费用与会话费用 | **保留**，原生命名/压缩不是最近活动回顾 |
| `pi-search-hub` **1.0.0** | 新 OpenAI 登录与旧 hosted backend 认证边界；可选结构化输出 | **保留**，原生 MCP 不提供多后端搜索策略 |
| `pi-context7` **0.1.1** | 可做原生 MCP 迁移试点；保留/更新 skill | **连接层可退役候选**，不是无损直接卸载 |
| `pi-herdr-companion` **0.2.0** | peers、虚拟 worktree start、BTW；新增 OSC 状态双源与 custom UI blocked 回归 | **保留**；原生状态不替代 panes/process/worktree/BTW |
| `pi-provider-cursor-ask` **0.1.5** | 真实流/认证/恢复回归；系统 section 重放旧缺陷另列 | **保留**，自定义 Cursor 协议不是通用 endpoint 配置 |
| `pi-provider-volcengine-agent-plan` **0.4.1** | 保留 compat 类型映射；回归 tier/thinking | **保留**，订阅端点与模型同名不是同一计费渠道 |

### 3.2 外部与本地资源

| 资源 | 结论 |
|---|---|
| Junie bridge **1.3.2 + 本地修改** | 保留。JetBrains OAuth、Grazie 代理、paid/EAP 许可选择、余额展示不被通用 provider 替代；真实请求未验证 |
| Ollama Cloud **0.12.2** | 保留。两处 chat 配置类型需适配；原生 llama.cpp 不是 Ollama Cloud，兼容 endpoint 也不涵盖其发现/额度/web 工具 |
| `herdr-agent-state.ts`，integration version **9** | 保留 session identity/socket 注册；原生 OSC 7501 仅可能替代部分重复状态发送，须先验证终端支持与双源优先级 |
| 已排除的 WTF / Context View / Figma / Moshi | 本次不必当活动升级阻碍。可做配置/依赖清理候选，但须先确认是否留作备用；不能据禁用状态直接删除工作目录 |
| pi-psql skill worktree | 不属于本次 SDK 扩展迁移；不要因 1.0 删除 SQL 使用约定 |

### 3.3 十个独立包的 peer 范围不覆盖 1.x

`pi-adversarial-review`、`pi-consult`、`pi-context7`、`pi-glance`、`pi-herdr-companion`、`pi-meter`、`pi-plan-mode`、`pi-search-hub`、`pi-todo`、`pi-tool-display-intent` 的 Pi peer range 含 `<1`。

这属于**支持声明与发布适配事项**：验证后需要更新，并明确仅支持 1.x 还是维持双版本。它不等于 Jiti 必然拒绝加载；根 bundle 的宽 peer range 也不代表每个独立包已验收 1.0。不得只去掉 `<1` 就宣布兼容。

---

## 4. 重点发现：影响、条件与证据

### 4.1 Subagents：steering 返回值与回执必须适配

**证据等级：差分类型检查 + 源码确认。**

`packages/pi-subagents/src/agent-manager.ts:544–553` 使用 `Promise<void>` 集合与返回值；1.0 `AgentSession.steer()` 返回 `Promise<QueuedInputDisposition>`，包含 `queued` / `handled`。

- 0.86.1 映射类型检查通过；1.0 在第 548、549、550、553 行产生四条新错误。
- Review main 的构建也通过导入同一源码出现这四条错误；不是 Review 自身另外四个缺陷。
- JS Promise resolve 为字符串本身不会导致运行崩溃，不能把编译错误夸成所有 steering 失效。
- 但 `agent-manager.ts:694–695` 不区分返回结果，仍回执 `steered`。输入若被 child 的扩展消费而返回 `handled`，就不应再声称已排入 child 推理队列。

**要求：**按真实 disposition 处理类型和回执，保留 rejection/settlement barrier；不能仅做类型断言，也不能遇到 handled 自动补发，否则可能重复副作用。

### 4.2 Review：实际安装的 embedded core 版本漂移

**证据等级：文件比对 + Node/Jiti 实际模块解析。**

```text
活动 root bundle → Subagents 0.2.3
Review external-v3 → 若探测成功，使用上述活动 runtime
Review embedded fallback → 独立安装 @zhcsyncer/pi-subagents 0.2.0
```

已安装 Review 的 `src/runtime/embedded-runtime.ts:194–195` 动态导入 `@zhcsyncer/pi-subagents/runtime`。从该 importer 用 Node/Jiti resolve，均指向全局独立包的 `src/runtime.ts`，其相对导入继续进入 **0.2.0** 的 manager/runner，而不是 bundle 0.2.3。

`resolve-runtime.ts` 的 external probe 默认只有 250ms；缺失、超时或不兼容时进入 embedded。选择 backend 后，不会因执行失败再切换。

旧 core 缺少 0.2.3 的 canonical 磁盘恢复/recipe；仍使用旧软上限 steering 和按 messages 数组长度判断结果边界。它仍有等待终态的 abort/cleanup，**不能说它只收 abort ACK 就删除资源**。

**影响：**fresh Review 并非必然失败，但两种 backend 行为不等价；main 的类型检查和 loader 成功不能验证实际 fallback。仅更新根 bundle 不会保证独立 `0.2.0` 被替换，`^0.2.0` 允许它继续存在。

**要求：**适配时同步实际依赖树，并分别验收 external 与 installed embedded。§4.1 的四条具体类型错误属于 0.2.3 实现，不能机械套到结构不同的 0.2.0 上。

### 4.3 工具展示：Bash 程序化输出被覆盖定义降级

**证据等级：精确 1.0 探针 + 父会话核对源码。触发条件：通过 codemode 调用被覆盖的 Bash。**

`packages/pi-tool-display-intent/src/tool-overrides.ts:2001–2015` 手工拼装原生定义，未保留 `outputSchema`。1.0 原生 Bash 有 schema，并返回 `structuredContent`；codemode 只有同时看到 schema 与 structuredContent 才把对象交给脚本。

探针结果：

```text
原生 Bash：outputSchema = true
覆盖 Bash：outputSchema = false
底层执行结果：仍有 structuredContent
120,000 字符输出：model-facing content 约 51 KB；structured output 仍为 120,000 字符
```

因此脚本收不到原生的 `{ output, exit_code, truncated, full_output_path }` 对象；非零退出时也从可检查结构化结果变成 rejected call。不是“底层没有生成完整输出”。

**要求：**装饰器保留完整工具契约，而不是扩大 TUI 预览上限。当前七个覆盖工具中只有 Bash 声明此 outputSchema，不能把其他六个 `false` 都判成回归。

**1.0.2 复核：**原生 Bash 实现与 1.0.0 一致，本地缺陷未被上游自动修复。1.0.1 的 `registerToolRenderer()` 提供了不重注册工具的纯展示入口；但本地还修改必填参数/提示和执行元数据，所以正确方向是分离展示与语义装饰，详见 §10.2。

同处确认丢失 `constrainedSampling`，且执行委托未传第五个参数 context，导致如 `PI_SESSION_ID` 等信息丢失；这两项在旧 SDK 已存在，应按既存问题处理。

### 4.4 聚合显示：nested 调用可能让整条 Run 消失

**证据等级：精确 1.0 工具组件探针。触发条件：aggregate 布局 + nested execution。**

`src/aggregate-activity.ts:2717–2724` 未区分 `parentToolCallId`，会把 nested ID 作为普通可见成员，后续选成 leader/渲染宿主；但 Pi 1.0 的 interactive renderer 明确不为 nested 调用创建独立工具组件。

探针中 `outer=codemode`、`outer/1=read`，leader 变为 `outer/1`，外层 `getView()` 为空，真实 `ToolExecutionComponent.render(100)` 返回 **0 行**。

这是显示丢失，不是执行结果或 session 文件丢失。历史重建也没有从 `nestedCalls` 恢复相同投影，实时与 reload 后可能不一致。

**要求：**nested 保留在外层宿主内展示，不能抢占不存在的组件；补实时/结束/reload 三种契约。

**1.0.2 复核：**新版仍不为 nested 调用创建独立组件。1.0.1 修复的是未连接 MCP 的历史调用默认渲染，不是本扩展的 aggregate leader 问题；renderer API 也不会自动重建聚合投影。

### 4.5 子代理工具隔离：嵌套执行需要独立安全验收

**证据等级：源码与 1.0 pipeline 确认。优先级：开放对应能力之前的安全门槛。**

`pi-subagents/src/agent-runner.ts:245–296` 用 active set 加 `session.agent.beforeToolCall` 实现 ext narrowing/pinned-only 限制。

1.0 nested pipeline 走 session 的 `_beforeToolCall`，不经过后来替换的 `agent.beforeToolCall`；已注册的 deferred/codemode 工具即使 inactive 仍可调用。

**1.1.0 复核仍成立。** 另从 1.0.4 起，CLI 与 SDK 的非空 `tools` 白名单可能保留未匹配的 MCP 注册；注册、激活、可调用须分开判断。它不是“单独 `--tools read` 就能越权执行”，也不表示当前 isolated Review 自动获得 MCP。精确条件和资源工具例外见 §11.3。

因此，当 child 有可用的程序化调用入口及相应已注册工具时，允许的工具可能调用被 narrowing/pin-only 排除的工具。**不是所有隔离都失效：**注册级 `excludeTools` denylist 仍有效；没有入口、没有相关注册工具的 isolated Review 路径也不等于可利用。

**要求：**把相同授权边界应用到顶层和 nested pipeline，覆盖晚注册工具。验收前不要通过简单打开 builtin factories 来扩展 child 能力。

反过来，Plan 用的是扩展 `pi.on("tool_call")` hook；该 hook 对 nested/MCP 仍生效。**不能把 Subagents 的问题写成 codemode 普遍绕过 Plan。**

活动 Plan 还允许受参数限制的 Explore/Plan Agent relay，main 则没有这条路径。这里证明的是父会话工具 hook 仍生效，不是整个委派链已经获得只读沙箱保证；角色名称和 `isolated:true` 不能证明 child 无写能力。实际角色工具配置与 child 执行约束仍需单独验收。

### 4.6 Todo、Consult、问卷、Plan 结束工具：建议明确顶层专用

**核心区别：sequential 只控制执行顺序，不表示不能被其他工具调用。**

| 工具 | 当前隐含契约 | nested 之后的影响 | 建议 |
|---|---|---|---|
| Todo | mutation checkpoint 放独立 `todo` toolResult 的 `details.state`；replay 按 toolName 找 | 当场 widget 可能正确，但 resume/tree/compact 缺 checkpoint，可能恢复旧状态 | 第一阶段 model-only；若要编程调用，另设计 branch-scoped checkpoint |
| Consult | 从顶层 transcript 构建证据；adoption 关联独立 consult 结果 | 看不到 script 内前序 nested 结果，未完成外层调用也未按原逻辑清理；采纳历史关联缺失 | model-only，并保留 alone 使用约定 |
| Ask User Question | 用户交互、独立答案历史、自定义 renderer | 并行脚本问卷、取消/等待冲突、答案不形成独立结果 | model-only；普通 TUI/RPC 未证实损坏 |
| submit_plan / complete_plan | 显式用户批准、独立展示、terminate/后续 turn | normal implementation 下 complete_plan 可被脚本调用，改变结束语义 | model-only，保留原审批协议 |
| Agent / get_subagent_result / steer_subagent | 独立会话、回执、用量水位 | nested result 不单独保存，恢复水位及重复结算有风险 | 首先评估 model-only，不急于支持脚本内委派 |

关键本地证据：Todo `todo.ts:78–93`、`tool/response-envelope.ts:137–159`、`state/replay.ts:130–153`；Consult `src/context.ts:14–24`、`src/adoption.ts:19–38`；Question `ask-user-question.ts:125–250`；活动 Plan `extensions/plan-mode.ts:507,721`。

当前 Consult 已主动剥掉父 system/tool deltas，并使用独立 system prompt + 空工具表；**没有证据表明升级就会向顾问泄漏执行权限**。

`model-only` 不保证一个 assistant batch 只有这一个顶层工具，所以 Consult 的“单独调用”约定仍需保留。

### 4.7 SDK child、恢复和计费不能只做一次加载测试

**原生工具继承：**`pi-subagents/src/agent-runner.ts:777–790` 的 loader 没有加入内置 factories。1.0 的 CLI 自动加载原生 MCP/codemode/tool-search，SDK 不自动加载。所以迁到原生 MCP 后可能出现“父会话有、普通 child 没有”。isolated child 和 Review 禁用它们反而符合现有契约。

**不同于 SDK child：**Herdr `/btw` 启动 CLI child，没有加 `--no-extensions`，不能一起判成丢原生 MCP。

**恢复：**

- 0.2.3 Subagents 的 `agent-runner.ts:1043–1066` 从 `buildSessionContext().model` 选恢复模型，可能拿到最后回答的物理模型而非所选 virtual router。
- `:1171–1179` 的 validator 要求 compaction 的 `firstKeptEntryId` 是此前 ID；但 1.0 合法 retain-none compaction 可以指向自身。确定性探针已被错误拒为 `Corrupt subagent session entry`。
- 后一项是“当前实现不接受 1.0 合法记录”的证据，未据此认定该合法形态只在 1.0 才首次出现。

**费用：**

- `agent-runner.ts:1262–1264` 的父层 rollup 只累计 assistant usage，遗漏 child 的 toolResult 模型用量。
- `usage-reporting.ts:73–79` 从顶层 Agent/get_result 结果恢复结算水位；若 nested 调用被折进外层，重载后可能重复报告同一笔费用。探针复现同一笔 15 tokens / $0.5 被重新报告。
- 这些问题不等于 Meter 一概不支持 codemode，见下一节。

### 4.8 Glance/Meter：总额、归属、界面要分开判断

**已正常：**codemode 内 `models.classify/generateImages` 及 nested tools 的 usage 汇总到外层 toolResult，Meter 与 Glance 都能累计。合成 `codemode.cost.total=0.7` 时两者均计入 **0.7**。不要报告“分类和图片全部漏账”。

**缺口：**

- 独立 `type:"usage"` 条目（例如 cache warming）被两者跳过；这是 0.86 适配文档已记录的旧缺口。
- Meter 对普通 codemode 汇总记到 `tool/codemode`，并不自动拆分每个实际 classifier/image model。
- 虚拟 router 自己调用 classifier 不等于 codemode 调用；没有自动把它并入 assistant 费用的契约，不能把旁路未上报全部归咎于 Meter。
- assistant 消息本身标记实际物理模型，Meter 对这条路径的模型归属正确。
- 父 Agent 汇总与 child session 账本已有防双计约定，应保留；不能额外逐 nested event 加一次账后又累计 outer usage。

**Glance 界面：**

- `theme-tone.ts:7–10` 只按名字识别 light/dark；system/custom theme 应使用新公共 `theme.appearance`。
- `theme-adapter.ts:100–103` 的颜色缓存 key 缺少同名 system 主题的明暗变化，working spinner 可能保留旧色；不代表整个编辑器都不刷新。
- `runtime-snapshot.ts:172–184` 只读取 selected `ctx.model`；替换原生 footer 后，缺少 1.0 原生的 `selected → routed model` 展示。

这些主题/虚拟身份问题需在采用对应能力时适配；你当前显式 dark、物理模型路径不应被描述为已经坏掉。

### 4.9 Fast Mode 与外部 provider：没有全面重写依据

**Fast Mode 确认需要校准的部分：**

- `extensions/stream-options.ts:154–185` 重建 options 时未透传 `onProviderStreamEvent`；新原始 provider 事件观察链断在这里。
- 本地 token 估算不计 `toolsRemoved`，system sections 计数与官方配方不同。同输入离线对照的输出预算为本地 **15904**、官方 **15550**；不是实测模型已经溢出。
- 三个 wrapper 未提供模型列表/鉴权，所以 1.0 composer 仍继承新 OpenAI OAuth 与各类型目录。**不要为适配额外注册一份 chat-only 目录，反而覆盖 image/classifier。**
- 原生 service tier 不替代 `/fast`、Ctrl+F、per-model 策略和状态展示。不同 provider 的 priority/fast 也不能未经验证直接统一改名。
- **1.0.2 新增条件性问题：**本地提前把模型 `samplingParams` 默认值合入请求级 options，官方再次合并时会用这些默认值覆盖 `samplingParamsByThinkingLevel` 的同名键。即使 Fast 开关关闭也可能触发。不是整张档位表丢失；复现与边界见 §10.3，1.1.0 重测仍成立。
- **1.1.0 新增估算偏差：**官方从 4 改为 3.5 字符/token，本地仍为 4。固定 32,000 字符输入的离线样例中，官方输出预算从 7904 收紧到 6761，本地仍为 7904。未配置档位采样也可能受影响；这证明安全预算没有同步，不是已证明某个真实请求溢出。见 §11.4。

**Ollama Cloud 类型问题：**

已安装 `models.ts:92`、`thinking-levels.ts:36` 使用 `ProviderModelConfig["compat"]` / `["thinkingLevelMap"]`。该类型现在是联合类型，字段不属于全部成员。最小类型契约探针在旧版通过、1.0 产生两条 TS2339。应收窄到 chat 类型。

这不是当前 Jiti 加载失败，也不是已跑完 Ollama 整包编译；两者须区分。

**外部 provider 已排除的误判：**

- 1.0 仍保留 legacy provider 注册、OAuth、旧 refreshModels 适配。
- Cursor 使用的 `pi-ai/compat` 与 `readStoredCredential` 未被删除；其认证存储格式未因本次升级整体迁移。
- Volcengine 保留自身 `pi-ai → compat.d.ts` 类型映射时，两版 typecheck 都通过；Pi extension loader 也提供对应运行时 compat alias。
- Junie 的 per-model API/baseUrl 覆盖仍被 composer 接受；Ollama 的 renderer/execute/key resolution 契约也仍在。

真实登录、刷新、流输出、quota 与服务端 tier 仍需上线前回归，不能只凭这些结果宣布全面兼容。

### 4.10 采用虚拟模型前，先解决跨扩展身份和旁路调用

| 路径 | 已确认的边界 |
|---|---|
| Recap | 默认取 `ctx.model` 后调用 raw `modelRegistry.complete()`；1.0 路由在 `streamSimple()` 路径，raw complete 不自动路由 virtual model，因而有执行失败路径 |
| Herdr worktree start | 先强制取 selected model 的 API key，再走 compat.complete；没有自身物理 key 的 virtual router 不满足此假设 |
| Glance | 只显示 selected model，看不到实际派发身份 |
| Consult | disabledForModels/日志主要按 selection 或配置 label；需要区分实际 response model；direct 路由也没有主循环 branch state |
| Review | 按所选 provider/model 去重；两个 router alias 可能派到同一物理模型，却通过“不同 reviewer”检查 |
| Subagents resume | 可能把 router 恢复成最后回答的物理模型 |

本地证据：Recap `extensions/recap.ts:581–598,666–671,736–758`；Herdr `src/worktree/start.ts:97–120`；Review `src/command/resolve-routes.ts:64–103`、`src/runtime/fleet-lifecycle.ts:85–96`；Subagents `src/agent-manager.ts:409–426`。

**建议首期 reviewer/顾问/主工作流仍明确选择物理模型。** 若以后支持 virtual，需要记录 selection 与 dispatch，不能用一个字段同时表示意图和实际执行证据。

---

## 5. 哪些可以退役，哪些不能

### 5.1 首选候选：Context7 的自维护 REST 工具层

**推荐程度：值得单独试点，不与宿主升级捆绑。**

Context7 官方提供 `https://mcp.context7.com/mcp` 及 OAuth 入口。原生 MCP 可以接管连接与认证，因此本地 REST client/工具注册层具备退役条件。

迁移前必须接受或补齐：

1. MCP 不自动读取现有 `extension-data/pi-context7/config.json`；需明确迁移鉴权或重新 OAuth，不能复制凭据到报告/源码。
2. server 名为 `context7` 时，工具名会变为 `mcp__context7__resolve_library_id`、`mcp__context7__query_docs`；现有 skill 的工具名和配置说明要更新。
3. 原生 MCP 默认走 codemode；若希望与现在一样直接可见，应显式选择 direct exposure。
4. 自定义候选摘要、UTF-8 大小/行数等展示不会自然保留；MCP 返回和截断行为也要验收。
5. 原生 MCP 不自动附带本仓库的“先 resolve、再 query”的使用约定；skill 应保留或独立打包。

本次核实了官方连接文档，**未连接真实服务、未做 OAuth 握手或工具声明实测**。因此结论是“可替换连接层”，不是“已经可直接卸载整个包”。

### 5.2 UI 扩展适合删除重复的底层职责

**更新至 1.0.2：优先使用官方 renderer resolver 承接纯展示，再决定哪些原型补丁可以逐项退出。** renderer 不修改参数 schema、提示或 execute，不能代替要求模型填写意图的语义装饰，也不直接解决跨组件聚合、鼠标和 viewport 协调。

| 可收缩部分 | 原生已有能力 | 不能顺带丢掉的差异 |
|---|---|---|
| Glance 按主题名字猜明暗 | `theme.appearance` | 自定义布局、Git、stash、working 行 |
| 仅为展示而重注册工具、等待工具出现的 renderer 发现逻辑 | 1.0.1 `registerToolRenderer()`，可处理尚未注册的历史工具 | 必填 displaySummary、参数准备、Write 执行元数据、aggregate 状态/交互 |
| 自行解析 ANSI RGB 的配色兼容层 | `theme.colors`、公共颜色工具 | Run 动画和视觉设计本身 |
| 标准 Bash 预览/耗时/截断提示 | 原生 renderer；1.1.0 提供完成后的记录型 durationMs | displaySummary 意图、运行中秒表、Run 聚合、定制预览行数 |
| 完成后单次工具耗时的自维护估算 | 1.1.0 execution_end/render context 的 durationMs，可随 toolResult 保存 | 未执行路径无值、旧历史 fallback、并行 Run 总时长与 HTML 差异 |
| 工具输出的纯外边距 | 1.1.0 扩大 outputPad 适用范围 | self shell 仍需主动处理；树线、鼠标坐标和 aggregate 布局不是 padding |
| 普通 edit 差异预览 | 原生预览/结果 diff | 特定分栏、折叠统计、Write 历史展示 |
| Glance 基础 tokens/cost/context/model segments | 原生 footer，且支持 routed model | 需要同时交还 footer ownership；只关 segment 不会恢复原生 footer |
| Fast Mode 自维护的通用 options 配方 | 官方 provider/options helper | `/fast`、快捷键、模型策略及必要特殊参数 |

建议方向是：**扩展保留用户可感知的差异，减少复制 Pi 内部契约。** 这不是要求一次重写 UI；应按已复现问题逐项拆除容易漂移的薄层。

### 5.3 不建议因 1.0 退役的完整能力

- **Subagents**：独立上下文、生命周期、后台投递、恢复、取消、资源约束，不是 codemode 的函数并行。
- **Plan/Todo**：计划审批与实现状态、有界任务周期、原子操作和恢复约束，不是普通 Markdown 清单。
- **Ask User Question**：多题 review、multi-select、Markdown preview、notes、快捷键和答案审计，不是一个原生 input/select。
- **Consult/Review**：独立建议、采纳记录、冻结证据、多路评审和终裁，不是分类器或 auto router。
- **Search Hub**：路由、fallback、有效结果源 combine/RRF、reader fallback、多 key/quota 与 setup UI，不是 MCP 协议本身。
- **Meter**：跨会话账本、预算和订阅窗口，不是 `/session` 当前会话总额。
- **Recap**：最近活动的一行回顾及终端标题联动，不是手动 `/name` 或上下文压缩。
- **Herdr 及 provider bridges**：管理特定运行环境/认证/协议/计费渠道，不会因为内置模型更多就自然消失。

`herdr_worker` 当前实现没有注册，可另行评估删除 dormant 代码，但这是已有未启用实现的清理，不是“被原生子代理取代”。

1.1.0 的 OSC 7501 新增局部状态去重候选，但**还不能删除 Herdr session 注册或 blocked adapter**：原生状态不携带等价的 session 文件/ID 协议，且 custom UI 问卷尚未纳入原生 blocked 接线。见 §11.2。

---

## 6. 既存问题：记录，但不要混成升级新增阻塞

| 问题 | 证据/现象 | 本次处理建议 |
|---|---|---|
| Meter/Glance 跳过独立 usage entry | cache warming 合成输入均计零；0.86 适配文档已有 | 若使用 warming，应补账；不是 1.0 刚出现 |
| Cursor system sections 没有按名替换/删除 | 同输入本地得到 old+removed+new，0.87.1/1.0 helper 均得到 base+new | 单独修复 transcript 语义，不做整个 provider 重写 |
| Tool Display 丢 sampling 与执行 context | 旧 0.86.1 已有这些原生字段 | 与新 schema 问题同处修，但注明来源 |
| 活动 Plan 测试类型债务 | 原生 0.84 基线通过；映射 0.86.1/1.0 均同样五条测试错误 | 先统一开发基线，再声明升级通过 |
| Recap / hosted search 旁路模型用量未进入主会话账 | 调用得到 response usage，但未按会话契约上报 | 独立制定用量归属，不声称 1.0 自动修复 |
| Recap `/tree` 后状态恢复不足 | 恢复主要在 session_start，而非 session_tree | 补分支回归，不冒充本次新增 API break |
| Fast wrapper 丢 raw hosted-search reasoningEffort | 当前只从 reasoning 重建，旧 composer 已有此路径 | 与 options 配方收缩一起处理 |
| Fast 内存设置生命周期与“进程内保留”口径不完全一致 | session runtime 重建会重建 factory；旧测试仅重发事件 | 先明确产品语义，非本次硬破坏 |
| Junie factory 清旧配置并启动代理 | 不符合“加载无资源副作用”的新旧文档建议；RPC hasUI 判断也需回归 | 后续治理；测试必须隔离 HOME，不仅隔离 agent dir |

Search Hub 的 hosted Codex backend 仍固定 `openai-codex` 登录；以后只保留新 `openai` ChatGPT 登录时需要适配。当前旧登录路径并未因 1.0 被删除。

另外，官方 OpenAI Responses adapter 对 ChatGPT token 不发送部分 API-key 参数。离线 fake-fetch 验证表明 Recap 的 300-token 配置在此认证路径下不是服务端硬上限；这不是 Fast 独有问题，也未验证真实服务端最终行为。

---

## 7. 首轮验证记录（2026-10-02，目标 1.0.0）

以下数据是首轮实测，保留原版本归属。2026-10-04 的 1.0.2 复核见 §10.6，未重复执行的检查不能视为新版通过。

### 7.1 精确 1.0.0 的隔离环境

在 `/var/tmp` 新建审计目录，只安装目标 `pi-coding-agent@1.0.0`，使用 `--ignore-scripts`；依赖包内的 AI/Agent/TUI/Codemode/MCP 也核实为 1.0.0。未更换全局 Pi。

加载探针逐项使用独立 HOME、agent dir 和工作目录，未提供真实凭据，禁止探针的 fetch。只执行 extension factory 注册，不主动 bind session、执行工具或请求模型。Junie factory 自身会启动临时本地代理，子进程退出后关闭；这正说明“只加载”也不能在真实 HOME 下随意进行。

### 7.2 类型与入口结果

| 检查 | 结果 | 解释 |
|---|---|---|
| 主仓库 16 包，映射 0.86.1 类型 | **16/16 通过** | 对照基线 |
| 同样 16 包，映射 1.0.0 类型 | **14/16 通过** | Subagents/Review 因同一处 Promise disposition 产生四条错误 |
| 22 个单独入口，1.0 loader | **22/22 加载及 factory 调用无异常** | 两个 Herdr 入口走未启用的 no-op 分支；不覆盖活动 Herdr 注册、session_start、真实请求、全屏 UI 或 dynamic embedded fallback |
| 活动 Plan，原有 0.84 SDK | 类型基线通过 | 与 main 开发环境不同 |
| 活动 Plan，0.86.1 / 1.0 类型 | 两者均五条相同测试错误 | `relay-runtime.test.ts:59,248,250`；非 1.0 专属回归，生产源文件无对应错误 |
| Ollama 联合类型最小探针 | 旧版通过，1.0 两条 TS2339 | 仅确认两个类型表达式，不是整个 npm 包编译 |

22 项组成：main 的 14 扩展 + 2 provider；活动 Plan；Junie；全局 Herdr state；已安装 Ollama；已安装 Volcengine/Cursor 两个入口。Herdr Companion 与全局 Herdr state 因探针不提供 Herdr 环境而提前返回，tools/commands/events 为空；其活动注册路径仍待验收。**本组检查也不包括实际构造 Review embedded 0.2.0 runtime。**

差分 typecheck 使用现有 TypeScript 6.0.3，在仓库外生成继承原 tsconfig 的配置，用 `paths` 映射精确 SDK 类型、强制 noEmit；保留项目自己的 compat 别名。第一次 Volcengine 探针覆盖该别名产生伪差异，恢复别名后两版都通过，最终结论已排除该误报。

### 7.3 现有测试与确定性探针

以下现有测试主要运行在旧开发依赖上，是行为基线，**不是 1.0 全套测试通过**：

| 范围 | 结果 | 实际 SDK/环境 |
|---|---:|---|
| Tool Display 重点测试 | 59 passed | 0.86.1 |
| Meter ledger | 44 passed | 0.86.1 |
| Glance state-inputs / working-indicator | 两脚本通过 | 0.86.1 |
| Todo replay | 13 passed | 0.86.1 |
| Consult context/execute | 11 passed | 0.86.1 |
| Question execute | 22 passed | 0.86.1 |
| 活动 Plan policy/relay runtime | 14 passed | 0.84.0 |
| Fast Mode | 33 passed | 0.86.1 |
| Recap contract/settings | 38 passed | 0.86.1 |
| Context7 | 21 passed | 0.86.1 |
| Search hosted-search | 8 passed | 0.86.1 |
| Junie models/license | 12 passed | Node 24.21.0，本地纯逻辑 |

针对 1.0 另外验证了：Bash schema/错误/120KB 输出、真实 aggregate 组件零行、主题 cache key、codemode usage、独立 usage entry、virtual selection 重建、inactive deferred callable、nested 用量水位重放、合法 compaction 被拒、provider options 与合成凭据 fake-fetch、模型 composer 接受情况。

这些检查没有真实模型费用，也没有证明模型输出质量。权限绕过与 Todo nested checkpoint 等结论基于完整执行/持久化契约核对，未冒充已跑全链路攻击或真实用户恢复测试。

### 7.4 副作用与未验证项

- 未修改扩展源代码、全局配置、真实凭据；未升级全局 CLI、提交、推送或发布。
- 一组旧基线测试最初使用 `pnpm exec vitest`，触发过 pnpm 依赖恢复与已有 provider prepare/build，随后改用已安装测试入口。收尾确认 Git 源码干净、宿主仍为 **0.87.1**、主仓 SDK 仍为 **0.86.1**、活动 Plan 仍为 **0.84.0**。因此不能声称 node_modules/生成物完全没有被触碰。
- Junie 原有 dirty 文件保留，未覆盖、回滚或提交。
- 未运行完整 1.0 单元/集成套件；未启动真实 MCP 服务、OAuth 登录、provider 推理或 quota 请求。
- 未做真实 TUI 输入/焦点/resize/鼠标/reload 全矩阵，未做性能或多模型质量 benchmark。
- disabled 包只检查配置与版本，不宣称其 1.0 兼容。

---

## 8. 建议的升级门槛与顺序

### 阶段 A：保持现有功能，完成宿主兼容

**不同时开启 codemode、原生 MCP 或 auto。**

先完成：

1. 修 Subagents steering 类型与真实回执；统一 Review 实际 external/embedded 依赖版本。
2. 修或覆盖已确认的合法 compaction 恢复问题，并验收 child resume/终态收尾；收敛活动 Plan 的开发基线和测试类型债务。
3. 校准 Fast options 透传与 1.1.0 token 估算；若采用档位采样，修正合并优先级。补齐 Tool Display 测试 Terminal 的新接口，再更新独立包 peer/development 支持范围。
4. 对当前实际 provider 做经授权的最小真实请求、工具循环、取消、登录刷新和会话恢复验收。

保留当前 fullscreen/dark 与 UI 设计。不要顺便迁所有 provider、重做套餐账本或替换全部扩展。

### 阶段 B：受控开启 codemode/MCP

**必须先过的安全/数据门槛：**

- 子代理顶层和 nested 调用遵守相同 allowlist/denylist/pinned-only 边界；覆盖新版 SDK 的 MCP 保留规则及三个资源工具，不能只检查 active 集合或 `mcp__*`。
- Todo/Question/Consult/Plan 交互与结束工具/Agent 编排工具的 exposure 已明确；首期采用顶层专用是更小的改动。
- Bash 结构化返回、aggregate nested 显示与 reload 后历史一致性通过。
- child SDK 内置 factories 采用显式能力策略；isolated/reviewer 不被意外扩大能力。
- child 工具用量不漏计，nested rollup 不重复结算。

先选低副作用、返回结构化数据的服务。MCP annotations 只是服务声明的提示，不能当成可信只读授权。Plan 保持 fail-closed，不以“readonlyHint=true”直接放行所有服务器。

### 阶段 C：可选替代与模型路由实验

- 单独试点 Context7 原生 MCP，验收 resolve→query、鉴权、工具名、skill、展示及失败体验后再删除旧连接层，避免两套同功能工具长期同时暴露。
- UI 去重优先采用 `registerToolRenderer()`，将纯展示与语义装饰拆开；不以新 API 为理由一次删除全部 override/prototype patch。
- 虚拟模型先在独立会话、明确任务边界试验；先解决 Recap/Herdr 旁路、Subagents 恢复、Review 身份及账单归属。
- 长会话保持一个稳定主模型、把边界清晰的任务委派给其他模型，仍是当前更容易审计的默认方式；这是一项工程建议，不是质量基准测试结论。

### 验收契约清单

| 类别 | 不能省略的验收 |
|---|---|
| Steering | queued 正常投递；handled 不谎报入队、不重试；rejection 保留 barrier |
| 权限 | 顶层/nested、direct/deferred/codemode、晚注册、pin-only、ext narrowing |
| 持久化 | Todo/Plan/Consult/Agent 在 resume、tree、compact、reload 后一致 |
| 渲染 | nested 宿主、resolver 顺序、历史/HTML/reload；新旧 duration、拒绝/抛错/运行中计时；outputPad 0/1 与 self/default/aggregate |
| 费用 | assistant、toolResult、usage entry、summary、child rollup；不漏/不双计 |
| 模型身份 | selection 与 dispatch 分离；virtual restore；reviewer 独立性 |
| 执行后端 | Review external 与 installed embedded 分别测；内部/外部取消与 agent_settled.aborted；等待实际终态再清理 |
| Provider | API key / 订阅登录、文本+工具、thinking、取消、刷新、长上下文；采样默认/档位/请求覆盖与 Fast 开关；Anthropic 同名工具重定义 |
| UI | fullscreen/regular、dark/system、TUI/RPC、窄屏、中文、问卷取消、reload；Home/End 与 Ctrl+Home/End；OSC 探测/双源与 custom blocked |

### 发布与回退边界

本报告不授权实施、发版或修改版本号。后续实施仍应遵守仓库 Changesets → version PR 流程，并在发布前列出包及当前/目标版本供确认。

试运行用独立 agent dir/测试会话；不要在唯一工作会话上验证恢复与迁移。升级前保留配置、session 与确切安装版本快照；回退时不要假定旧 Pi 能完整理解已经写入的新工具/路由记录。禁止把真实认证文件放进报告或 Git。

---

## 9. 主要来源与可追溯入口

### 首轮上游固定版本（1.0.0；后续增量来源见 §10.7 / §11.8）

- [Pi 1.0 官方发布说明](https://github.com/earendil-works/pi/releases/tag/v1.0.0)
- [Pi 1.0 发布博文](https://earendil.com/posts/pi-1-0/)
- [为何接纳 MCP](https://earendil.com/posts/you-said-no-mcp/)
- [Coding Agent changelog，v1.0.0](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/CHANGELOG.md)
- [AI changelog，v1.0.0](https://github.com/earendil-works/pi/blob/v1.0.0/packages/ai/CHANGELOG.md)
- [Agent Core changelog，v1.0.0](https://github.com/earendil-works/pi/blob/v1.0.0/packages/agent/CHANGELOG.md)
- [TUI changelog，v1.0.0](https://github.com/earendil-works/pi/blob/v1.0.0/packages/tui/CHANGELOG.md)
- [Codemode changelog，v1.0.0](https://github.com/earendil-works/pi/blob/v1.0.0/packages/codemode/CHANGELOG.md)
- [Extensions 契约](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/extensions.md)
- [SDK 与内置扩展装配](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/sdk.md)
- [MCP 配置/曝光/认证](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/mcp.md)
- [Codemode](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/codemode.md)
- [Virtual Models](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/virtual-models.md)
- [发行包 Jev Router 示例](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/examples/extensions/jev-router.ts)
- [Session Format](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/session-format.md)
- [Context7 官方客户端连接文档](https://context7.com/docs/resources/all-clients#built-in-mcp)（外部服务当前文档，不是 Pi tag 内文件）

### 本仓库与实际安装证据

正文中的源码位置相对仓库根，行号基于本报告开头的 commit。关键入口：

- [Subagents runner](../packages/pi-subagents/src/agent-runner.ts)、[manager](../packages/pi-subagents/src/agent-manager.ts)、[usage reporting](../packages/pi-subagents/src/usage-reporting.ts)
- [Review embedded runtime](../packages/pi-adversarial-review/src/runtime/embedded-runtime.ts)、[runtime resolver](../packages/pi-adversarial-review/src/runtime/resolve-runtime.ts)
- [工具覆盖](../packages/pi-tool-display-intent/src/tool-overrides.ts)、[聚合投影](../packages/pi-tool-display-intent/src/aggregate-activity.ts)
- [Todo replay](../packages/pi-todo/state/replay.ts)、[checkpoint envelope](../packages/pi-todo/tool/response-envelope.ts)
- [Consult context](../packages/pi-consult/src/context.ts)、[adoption](../packages/pi-consult/src/adoption.ts)
- [Fast options](../packages/pi-fast-mode/extensions/stream-options.ts)、[Recap](../packages/pi-recap/extensions/recap.ts)
- [Glance snapshot](../packages/pi-glance/runtime-snapshot.ts)、[Meter parser](../packages/pi-meter/src/ledger/session-parser.ts)
- [既有 0.86 适配结论](./pi-0.86-extension-adapt.md)、[锁定的上游 fork 取舍](./upstream-forks.md)、[已知 backlog](../BACKLOG.md)

工作区外证据以实际文件为准：

- Plan：`/root/.herdr/worktrees/pi-agent-cases/feat-plan-mode-subagent-explore/packages/pi-plan-mode/`，commit `de32f84`。
- Junie：`/root/develop/ai/pi-jetbrains-junie-bridge/`，commit `42f4d73` 加本地修改。
- npm 实际安装：`/root/.agent-vm-state/pi/agent/npm/node_modules/`；其中 `@zhcsyncer/pi-subagents` 为 `0.2.0`，不能用 main 的路径替代推断。

隔离探针是本次审计证据，不是新增产品测试资产；关键输入、结果、版本和限制已归纳在 §4/§7/§10。后续修复应把相关契约转成仓库内可重复执行的回归测试，而不是依赖临时审计目录。

---

## 10. 1.0.1 → 1.0.2 增量复核（2026-10-04）

本节保留当时的增量结论与实测；现行目标已更新为 1.1.0，最新复核见 §11。

### 10.1 需要更新报告，但不是推翻原结论

**建议升级目标从 1.0.0 调整为 1.0.2；原有安全、持久化、恢复与安装版本漂移问题仍须处理。** 本轮最重要的差异是：显示层有了更合适的官方改造入口，以及 Fast Mode 对新采样配置出现了可复现的条件性行为错误。

| 版本 / 变化 | 用户可感知的价值 | 对本报告的影响 |
|---|---|---|
| 1.0.1：`registerToolRenderer()` | 不必重注册工具就能定制显示；未连接/尚未注册的历史 MCP 工具也可渲染 | **改变 Tool Display 的推荐改造路径**，但不自动修复现有 wrapper/aggregate |
| 1.0.1：MCP 项目覆盖 | 一个项目可停用全局 server 或调整 exposure，不必复制连接/认证配置 | Context7 等迁移试点更容易隔离；不等于已验证具体服务兼容 |
| 1.0.1：MCP CIMD / 登录 URL 复制键 | 支持另一种 OAuth 客户端登记方式，远端登录更方便 | 按服务端要求启用；不是所有 MCP 都应切到 CIMD |
| 1.0.1：Anthropic inline tools | 会话中同名工具重新定义时，保留初始工具前缀并内联新定义 | 有利于动态工具/缓存；不是通用 transcript 契约改写 |
| 1.0.1：codemode 输出硬上限 | 防止脚本不断打印耗尽内存 | 新增超限/错误回归；不是更改 Bash 的结构化输出上限 |
| 1.0.1：MCP 历史及终端图片修复 | 恢复会话、HTML、Kitty 协议终端显示更稳 | 上游修复不等于本地聚合逻辑已经兼容 |
| 1.0.1：Clef / Clef Flash | Cloudflare 增加分类模型选择 | 新增 Jev 之外的内置远端分类选择；并未附送通用 auto 策略 |
| 1.0.1：安装与依赖策略变化 | 官方托管安装锁依赖；npm 包移除 shrinkwrap；新增 Nix flake | **验收需记录实际依赖树**，不能只记录 CLI 版本号 |
| 1.0.2：`samplingParamsByThinkingLevel` | 同一模型在不同思考档使用不同 temperature/top_p 等 | **新增 Fast 的同名键合并优先级适配**，见 §10.3 |

按官方 changelog，1.0.2 的 Coding Agent/AI 增量集中于档位采样；本轮没有新增原生 Todo、Plan、Subagents、顾问、搜索聚合或 Herdr 工作流。大多数包保留、Context7 连接层可试点替代的结论不变。

### 10.2 Tool Display：纯展示迁移，不是整层删除

1.0.1 新接口是 `pi.registerToolRenderer((toolName, next) => renderers)`。返回的 `ToolRenderers` 仅含 `renderShell/renderCall/renderResult`，不修改 schema、prompt 或 execute。

它可以处理当前调用、历史调用及 HTML 导出，包括工具尚未注册的情况。resolver 按扩展加载/注册顺序连接；必须调用 `next()` 才进入下游，且不会自动逐字段合并。`next() ?? mine` 只是下游缺省时补位，不是覆盖已有 renderer。

对本扩展应分三层处理：

1. **纯展示层**：优先迁到公共 renderer API，减少仅为显示而重注册、修改工具定义或等待动态工具出现的逻辑。
2. **语义装饰层**：保留必要的 `displaySummary` 必填 schema/提示、参数清理以及 Write 执行前旧内容捕获；完整透传原工具契约和第五参数 context。
3. **聚合与交互层**：nested 外层宿主、历史投影、展开同步、执行计时、鼠标/viewport 协调单独验收；不能因为有新 API 就认定所有 prototype patch 可直接删除。

本地证据：`tool-overrides.ts:299–315,2001–2015,2148–2171`；`display-summary.js:97–122,175–199`；`aggregate-activity.ts:2447–2593`。上游 1.0.2：`dist/core/extensions/types.d.ts:499–504,1218–1219`、`dist/core/extensions/runner.js:541–546`。

边界：renderer 在组件创建时解析，不保证晚注册后旧组件即时换样式；HTML 会调用 call/result renderer 后转换输出，不等价执行 TUI 的外壳、交互和图片布局。原生历史 MCP 渲染修复，也不是 §4.4 聚合宿主消失问题的修复。

### 10.3 Fast Mode：新采样配置存在同名键覆盖错误

1.0.2 的有效合并顺序是：

```text
模型 samplingParams
  → 有效 Pi thinking level 对应的 samplingParamsByThinkingLevel
  → 请求级 samplingParams
```

后者按键覆盖前者；先将思考档钳制到模型支持的等级，再查表，不是使用映射后的 provider effort 字符串查表。未指定 reasoning 通常按 off 起算；若 off 不支持仍会被钳制。适用 API 为 `openai-completions`、`openai-responses`、`azure-openai-responses`，不表示所有 provider 都接受任意采样字段，也不表示它会选择模型或判断任务难度。

本地 `pi-fast-mode/extensions/stream-options.ts:161–167` 提前把模型默认值并入请求级 options。官方 adapter 再次合并时，把这些值当成显式请求覆盖，导致档位配置同名键失效。

本轮对实际 helper 的离线复现：

| 输入 | 官方结果 | Fast 包装后结果 |
|---|---|---|
| 默认 temperature=1；high 为 temperature=0.3、top_k=20 | 0.3 / 20 | **1 / 20** |
| 默认 temperature=1；off 为 temperature=0.4 | 0.4 | **1** |
| 上述 high 配置，再显式请求 temperature=0.2 | 0.2 / 20 | 0.2 / 20 |
| 只有 high 档位配置，无模型默认值 | 0.3 / 20 | 0.3 / 20 |

因此，**错误是默认值与档位值重名时的优先级，不是整张表被丢弃**。原 model 对象仍保留，provider effort 映射也未被证实有误。Fast 关闭时 wrapper 仍执行，所以关闭加速开关不是该问题的通用规避方式。

最小适配方向：同步官方完整的三层合并语义，不只是新增字段透传；连同已有的 provider stream hook 透传、估算偏差一起验收。尚未使用该配置的现有任务，不应被描述成必然出现参数错误。

### 10.4 上游修复的受益边界

- **Anthropic inline tools**：改的是官方 serializer 的 wire 表达。满足原生中途 system/tool 支持条件时，新增/同名重定义工具以内联完整定义发送；不满足条件仍使用兼容路径。system sections、toolsAdded/toolsRemoved 的重放算法未因此改变。Cursor 的自定义 serializer 不会自动获得修复。
- **弃用并非删除**：`hasToolRedefinitions()` 仍保留，新增 deprecated 标记。本仓 `packages/`、`providers/` 精确检索无直接调用，不新增对应迁移任务。
- **MCP 低层存在真实 breaking change**：`OAuthClientProvider.clientMetadataUrl` 被 `clientMetadataDocument(metadata)` 替代，发生在 `pi-mcp@1.0.1`。本仓上述目录没有该旧符号直接使用；不能泛化成所有现有扩展必须改，也不能因 patch 版本就忽略低层 SDK 变更。
- **图片**：普通 Pi CLI 已按需装配非 PNG→PNG transcoder，扩展在正常 CLI 中使用共享 `Image` 不需要各自注册。独立 pi-tui 宿主才需检查自己的 `setImageTranscoder()` 装配。未做真实终端图片测试。
- **输出限制**：codemode 脚本输出超过 **16 Mi 字符或 100000 项**会失败。这里不是 token 数，也不是 Bash 结构化结果的 1 MiB 上限；不意味着所有内存问题都已解决。
- **其他修复**：模型 at-capacity 重试、ChatGPT 回调端口占用、Cloudflare Claude model ID、Bedrock 定价/思考签名、Together/NVIDIA 默认模型等，按实际使用渠道受益；未因此证明本地自定义 provider 的所有真实请求正确。

### 10.5 MCP 与安装方式：新增能力不扩大退役结论

`.pi/mcp.json` 条目不含 `command/url/type` 时，可只覆盖同名全局 server 的 `enabled/exposure/toolExposure`，连接参数与鉴权仍继承全局配置。项目配置仍须获得 trust；这很适合按项目试点 Context7，而不是复制凭据。

CIMD 需要授权服务器支持，且有与 clientId/clientName 等配置的互斥约束。未验证 Context7 或其他实际服务器需要这项能力，不能仅凭新增 CIMD 就宣布原 REST 层可立即删除。

1.0.1 移除了发布包内的 `npm-shrinkwrap.json`。固定 `pi-coding-agent@1.0.2` **不再单独保证相同传递依赖树**；官方托管 installer 仍提供锁定安装，`pi update` 会向全局 npm 用户建议迁移。这不是必须在本次分析中执行的安装迁移。

后续验收应记录/固定完整依赖图，再决定沿用包管理器锁定还是采用托管安装；不要把宿主升级、安装方式迁移和全部扩展重构捆在一起。官方同时固定 `brace-expansion` 5.0.12 以处理发布说明列出的安全问题；本次未运行完整漏洞扫描，不据此宣称现有宿主一定受影响或新版没有其他漏洞。

### 10.6 本轮重新验证了什么

环境快照：main 仍为 `f48a91b`，CLI 仍为 **0.87.1**；根 bundle `1.0.2`、独立 Subagents `0.2.0`、Review `0.1.1`、Ollama `0.12.2` 的版本复核未变。没有重新全量审阅全部外部工作副本。

本轮在 `/var/tmp` 分别安装精确宿主 **1.0.0 / 1.0.2**，使用 `--ignore-scripts`；核实 AI、Agent Core、TUI、Codemode、MCP 的实际解析版本分别与目标一致。1.0.0 包有 shrinkwrap，1.0.2 包没有；本轮碰巧解析到齐套 1.0.2，不是未来安装仍一致的保证。

| 复核项 | 结果与结论 |
|---|---|
| 16 个仓库包，1.0.0 vs 1.0.2 差分类型检查 | 两者均 **14/16**；Subagents/Review 的四条 Promise disposition 诊断逐字一致；未新增其他类型诊断 |
| `steer/followUp`、nested pipeline/callable 选择、权限入口、getSessionStats | 提取方法体对比，均与 1.0.0 一致；不是仅因 changelog 没提就推定未变 |
| nested runner、model runtime/registry、session manager、virtual routing | 对照发行包对应文件，内容一致；旧状态/恢复/旁路路由问题没有被这些补丁自动消除 |
| SDK、virtual model、session format 文档及 Jev 示例 | 文件一致；SDK 仍需内置 factories，nested 仍无独立结果条目，示例仍为原来的阶段路由 |
| 原生 Bash 与本地 wrapper；nested TUI 组件 | 定向源码复核；旧因果链保持，本轮未重跑 120KB/零行组件探针 |
| 新采样优先级 | 实际 helper 的四组合离线复现；另核对官方 adapter 构造 payload，无真实网络调用 |
| Anthropic 同名工具重定义 | 离线对照官方 payload：新版内联新定义，旧版重发当前定义；兼容 fallback 未发现对应语义迁移 |
| 原生 renderer / 图片装配 | 精确 1.0.2 文档、类型、调用链审阅；未真实运行 TUI/HTML 整套回归 |

**未重跑**首轮 22 入口 factory 检查、全部既有测试、活动 Plan 全套、所有真实 provider/MCP/UI 场景。§7 的 22/22 和旧测试结果仍只属于当时目标，不转写为 1.0.2 通过。

本轮没有运行仓库 pnpm/npm 命令，没有修改依赖声明/锁文件、扩展源码、全局配置或真实凭据；只有隔离 SDK 安装、noEmit 类型检查和离线参数构造。临时依赖在报告验收后清理，不作为产品资产保留。

### 10.7 增量来源

- [v1.0.1 Release](https://github.com/earendil-works/pi/releases/tag/v1.0.1)、[v1.0.2 Release](https://github.com/earendil-works/pi/releases/tag/v1.0.2)
- [Coding Agent changelog，v1.0.2](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/CHANGELOG.md)
- [Tool rendering 契约，v1.0.2](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/extensions.md#tool-rendering)
- [按 thinking level 采样，v1.0.2](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/models.md#configure-sampling-by-thinking-level)
- [MCP 配置与 OAuth，v1.0.2](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/mcp.md)
- [MCP SDK changelog，v1.0.2](https://github.com/earendil-works/pi/blob/v1.0.2/packages/mcp/CHANGELOG.md)
- [安装方式说明，v1.0.2 README](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/README.md)

**当时增量判断：更新升级目标、显示层改造路线、Fast 新采样适配和安装验收要求；不撤销原有核心风险，不扩大整包退役名单。**

---

## 11. 1.0.3 → 1.1.0 最新复核（2026-10-08）

### 11.1 版本确认与关键增量

本轮直接读取 npm registry 的 `@earendil-works/pi-coding-agent/latest`，确认为 **1.1.0**，与 GitHub `v1.1.0` Release 一致；未以可能缓存的 npm 网页列表推断。1.0.2 后依次发布了 **1.0.3、1.0.4、1.1.0**。

**总体判断：升级目标改为 1.1.0，旧适配问题未被补丁消除；新版本扩大了公共显示/状态接口，同时改变了工具选择边界。**

| 版本 / 变化 | 适用场景 | 对当前扩展的影响 |
|---|---|---|
| 1.0.3：Azure provider 改名 `azure` | Azure OpenAI / Foundry 部署 | 真正的配置/导入迁移；API 标识仍可为 `azure-openai-responses`，不可全局替换 |
| 1.0.3：codemode 图像落临时文件、输出文件权限收紧 | 后续回合复制/移动生成图片、保护截断全文 | `image()` 新行为；不是 `generateImages()` 一调用就全部自动落盘 |
| 1.0.3：Home/End 调整 | 全屏编辑与历史导航 | 行首/尾用 Home/End，历史顶/底用 Ctrl+Home/Ctrl+End；Glance/问卷需回归键盘体验 |
| 1.0.4：工具通配、MCP 保留、`--no-mcp` | 大工具集、限制特定 MCP server | **CLI/SDK 工具白名单语义变化**，见 §11.3 |
| 1.0.4：`ToolLoadout.getPromptGuidelines()` | codemode 隐藏直接工具声明 | 提示更一致；不是权限或持久化修复 |
| 1.0.4：read 图像返回、冻结脚本内建对象 | 脚本处理图片、避免原型修改破坏运行 | 图片可送给 `image()`/分类器；仍非操作系统沙箱 |
| 1.1.0：记录型 `durationMs`、renderer `outputPad` | 完成后的工具耗时、统一留白 | 可去重部分实现；运行中计时、聚合、HTML 仍需区别处理 |
| 1.1.0：OSC 7501 / `agent_settled.aborted` | 终端看板状态、取消与正常结束区分 | 新增测试 Terminal 接口；Herdr 桥接仍有独立职责 |
| 1.1.0：`--tools +name/-name` | 在默认工具上增减 | SDK `tools` 同样支持；不等于 `pi.setActiveTools()` 也支持此语法 |
| 1.1.0：Haiku 5.5、GPT-6 Luna 分类/图像分类、本地原生 decision models | 小模型任务、文本/图片分类、本地分类 | 增加选择；不会自动提供可靠 auto 路由或替代顾问/审查 |
| 1.1.0：3.5 字符/token 估算、长提示阶梯计价修复 | 靠近上下文上限、长输入费用 | **Fast 本地配方继续漂移**；普通路径可继承官方计费修复，旧账不会自动重算 |
| 1.0.3–1.1.0：OAuth、MCP、重试及 UI 修复 | 取消、关闭、登录、满载重试、终端关闭 | 宿主稳定性收益；不是所有自定义 provider 的端到端兼容证明 |

### 11.2 显示与状态：更有条件减负，但不能整包退役

#### 新增必须适配的测试接口

`pi-tui.Terminal` 新增必需的 `setProgramStatus()`。本地 `pi-tool-display-intent/tests/helpers/aggregate-terminal.ts` 的 `AggregateTerminal` 未实现该方法，导致 **五条类型诊断**：helper 第 9/109 行，以及 aggregate reload/viewport-ledger/viewport 的使用点。

这使 16 包类型检查从 1.0.2 的 **14/16** 变为 1.1.0 的 **13/16**。五条来自同一测试 adapter，**不能解释为生产终端渲染已经崩溃**。更新 fixture 并回归相关行为后才能恢复验收。

#### durationMs 的可替代范围

原生 `durationMs` 表示**一次工具 execute 的已记录耗时**：正常返回和抛错都有；校验失败、权限拦截等未执行路径没有值。执行前后 hooks、部分等待不在该口径内。它进入 execution_end 与最终 toolResult，TUI 可在 reload 后读取。

- 可以替换完成后单工具耗时的部分自维护估算，尤其是从消息时间戳重建的近似值。
- 运行中值仍为 undefined，**不能删除 running spinner/秒表**。
- Run/turn 总时长不是各工具耗时之和；并行、模型生成、等待仍需独立口径。Glance 的整轮工作状态不被它替代。
- 旧历史无字段要用明确 fallback 或不显示，不能当零。
- nested execution 事件的执行耗时、`nestedCalls` 从 runner 入场计时、codemode 子行包围调用的计时，不是相同口径，不能简单覆盖或累加。
- **1.1.0 的 HTML 自定义 renderer 仍拿到 `durationMs: undefined`**；不能宣称所有导出和历史路径都已统一。

本地 aggregate 尚未消费原生完成耗时，且 nested leader 问题仍存在。保留 §10.2 的 renderer/语义装饰/聚合三层划分。

#### outputPad 与 OSC 7501 的边界

`outputPad` 的适用范围扩展到工具、`!` 输出与 summary。默认 shell 可自动应用；`renderShell:"self"` 要自行处理。本地 Claude/self 与 aggregate 布局不能因为新增字段就删除树线、折叠、鼠标坐标或 viewport 协调。若要求全局 0/1 一致，需专门适配；这不是已证实的运行崩溃。

OSC 7501 可以向支持的终端报告 working/blocked/done/error/idle，**默认先探测支持，不是无条件发送**；`PI_PROGRAM_STATUS=1|0` 可覆盖。未验证当前 Herdr 的应答支持与双源状态优先级，tmux/screen 的转发限制也应考虑。

不能直接废弃现有 Herdr 桥接，原因不止“尚未测过”：

1. 全局 integration v9 还通过 socket 发送 pane/source/seq、session 文件/ID 和 session_start/reload 状态；OSC 没有等价的 session identity 注册。
2. 原生 blocked 接入标准 select/confirm/input/editor/login，**未覆盖 `showExtensionCustom()`**；本仓问卷使用 custom UI，因此 Companion 的 blocked adapter 仍有价值。
3. 两路并用是否覆盖/闪烁/重复通知须真实验收；不能预先宣称冲突，也不能预先删掉旧路径。

可退役候选是“重复的根状态发送部分”，不是 Companion 的 pane/process/worktree/BTW，也不是所有 custom blocked 处理。

### 11.3 工具选择：变化同时作用于 CLI 与 SDK

这部分需更新此前把显式工具表当作完全隔离边界的假设。

- 1.0.4 的 `*` pattern 适用于 CLI `--tools/--exclude-tools` 和 SDK `tools/excludeTools`，区分大小写。
- 1.1.0 的 `+name/-name` 也适用于 SDK `tools`，整份列表必须全为 modifier，按顺序修改默认集；只能用精确名字，不能混普通条目或通配符。
- **`pi.setActiveTools()` 没有获得这些语法**，仍以已注册的精确名称替换 active 集合；活动 Plan 不能直接传 `+read`。
- `--no-mcp` 是 CLI 对内置 MCP loader 的禁用项，不是 `createAgentSession.noMcp` 参数，也不禁用替代 MCP 扩展。SDK 应明确控制相应 factory/loader。

以下是两版 SDK 选择片段与注册门禁的纯探针结果，**不是模型立即可调用工具列表**：

| 输入 | 1.0.2 注册门禁 | 1.1.0 注册门禁 |
|---|---|---|
| `tools:["read"]` | 仅匹配 read | 另保留 MCP 工具及资源工具 |
| `noTools:"all", tools:["read"]` | 仅匹配 read | 同样保留 MCP 注册 |
| 仅 `noTools:"all"` 或 `tools:[]` | 全拒 | 仍全拒工具注册 |
| `tools:["read","codemode","mcp__a__*"]` | `*` 不展开 | MCP 仅保留匹配项 |

**仍注册不等于立即可达：**未匹配的 direct MCP 不会激活，不能靠恢复 active 集合绕过；codemode/deferred 则保持程序化可调用，配合允许的间接调用入口才可能执行。`hidden` 不可达、`model-only` 不可 nested，执行时权限 hook 仍有效。原生 read 本身没有编排能力，因此不能把单独 `--tools read` 写成已复现的越权。

另一个重要例外：`excludeTools:["mcp__*"]` **不匹配** `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`。排除全部 MCP 工具要涵盖这三个名字；名称过滤本身也不阻止连接服务器。不能把工具过滤与连接层关闭混为一谈。

对本地实际路径的判断：

- Subagents 尚未装配 SDK 原生 factories，升级不会凭空增加原生 MCP；但后续接入时应重新验收上述规则。
- 有扩展路径主要传 `excludeTools`、用 active+narrowing 和自定义 agent hook 收窄；§4.5 的 nested 绕过该低层 hook 的条件性问题仍在，不是本次 MCP 保留规则才造成的。
- 无扩展静态 tools 路径若将来装配 MCP，不能再称为对所有工具的注册硬白名单。
- Review 当前的只读/空工具、extensions=false、isolated 路径，在无额外 connector/pinned 工具入口时，**未据此证明存在新增可利用路径**。installed embedded 0.2.0 仍不能用 main 0.2.3 代验。
- 活动 Plan 的扩展 `tool_call` fail-closed hook 仍覆盖 nested；其 Agent relay 的 child 约束另验。
- Herdr BTW argv 没有 tools/no-tools/no-mcp，新增选择语法未直接命中；它仍走 CLI 默认装配，不是 SDK child。
- 本地 Agent frontmatter 的 `*`/`ext:`/精确 Set 逻辑不是上游 CLI parser，**不能宣传其自动获得同一套 modifier/glob 支持**。

`ToolLoadout.getPromptGuidelines()` 把指导带入 codemode 声明、避免系统提示继续点名隐藏工具；本地未发现直接实现该 hook 的适配点。它修的是提示一致性，不会补回 wrapper 丢失的字段，也不是授权/checkpoint 修复。

### 11.4 Fast Mode：采样旧问题仍在，新增更保守的估算差距

1.1.0 将输入估算从 **4 改为 3.5 字符/token**，目的在于减少上下文极限附近的请求失败。本地 `stream-options.ts` 仍是 4。

固定离线输入：一个 32,000 字符 user message；contextWindow=20,000，maxTokens=16,000，安全余量沿用原配方。

| 配方 | 1.0.2 输出预算 | 1.1.0 输出预算 |
|---|---:|---:|
| 官方 buildBaseOptions | 7904 | **6761** |
| 本地 Fast buildBaseOptions | 7904 | **7904** |

这证明本地没有继承更保守的预算，**不是已经测出真实模型拒绝请求**。它不依赖新采样配置，Fast 关闭时 wrapper 也仍执行，因此应与已有估算/事件透传适配一起处理。

同时重测默认 temperature=1、high=0.3/top_k=20：1.1.0 官方仍得到 **0.3/20**，本地仍得到 **1/20**。§10.3 的三层合并错误没有被新版本消除。

Provider composer 与 1.0.2 的对应实现一致；当前 Fast 不提供模型列表的包装方式仍不构成“新增分类模型目录被它整体删掉”的证据。真实渠道支持的参数、认证及费用仍需单独回归。

### 11.5 Azure 与分类模型：配置迁移和新选择

**Azure 要区分 provider 与 API：**

- provider ID 从 `azure-openai-responses` 改为 **`azure`**；相关认证/provider 配置键、默认 provider、enabledModels/modelThinkingLevels 中的 provider 前缀需迁移。
- SDK provider 工厂/目录迁到 `providers/azure` 的 `azureProvider` / `AZURE_MODELS`。
- **API 标识 `azure-openai-responses` 仍有效，`AZURE_OPENAI_*` 环境变量不变。** 新 provider 同时装配 Responses 和 Chat Completions；采样文档使用旧字符串作为 API 类型是正确的，不是文档漏改。
- 旧 provider 的会话可能恢复到其他模型且丢失原 prompt cache，不能只测新会话。

本仓 `packages/`、`providers/` 对旧 provider 名/旧工厂符号的定向检索无命中；未读取用户 auth.json，所以这里只列“使用 Azure 时必须迁移”，不判定当前所有 provider 都受影响。禁止对全部字符串做无差别替换。

**分类能力增加，但不等于 auto 已经完整：**

- GPT-6 Luna 可通过 OpenAI Decisions API 判断 JSON state 和图像，例如批量截图是否存在遮挡；这是分类操作，不是切换聊天模型。
- 它需要 **OpenAI API key**，ChatGPT 订阅凭据不能使用。官方文档还明确：openai 已保存 ChatGPT 登录时，即使设置环境 API key，该分类模型也不会列为可用。宜在隔离配置中试验，不为试分类而擅自退出现有登录。
- llama.cpp 0.6.0+ 对 Julia-1、Laya、Kev、lev、OpenJev 等原生 decision 模型走 `/v1/systemone`，它们只作为分类器列出；不能把聊天 picker 看不到它们判成丢模型。
- classifier 不出现在 `/model`；仍通过 codemode 或模型运行时调用。新模型没有替你定义路由策略，也没有验证长会话混模型质量。

Virtual Models 文档、路由实现、Jev 示例及 ModelRuntime 的 stream/complete/streamSimple 方法与 1.0.2 对照未变。§4.10 的 selection/dispatch、旁路 complete、恢复和 Review 独立性问题没有被新分类模型修复。

### 11.6 收尾事件及其他回归点

`agent_settled.aborted` 是新增的**取消事实标记**，不是成功标记，也不是新的终态等待机制。本轮纯探针对照的顺序仍为 cache → extension settled → subscriber settled → deferred actions → idle；不能用这个字段取代等待 prompt/abort/waitForIdle。

Subagents 目前主要根据限次与外部 signal 判断 aborted。若 child 内部直接调用 session.abort 而没有触发 manager signal，可能误报完成或继续队列；新字段提供更可靠的观察点。这是值得补的内部取消契约，不是本次收尾顺序被破坏。Plan 在 settled 无条件清理运行标记则可以不分取消/正常。

其他值得验收、但不应扩大成全仓重写的事项：

- MCP OAuth 可在各阶段取消，授权请求 15 秒超时，shutdown 不再为即将关闭的连接等待刷新；`/mcp` 管理器实时更新，不再等全部服务器连接。
- 1.0.3 修复取消 OAuth 刷新导致订阅 refresh token 失效，以及运行中的 pnpm 安装被替换后 codemode 无法再启动的问题；仍建议升级后重启，而不是把热替换当无条件支持。
- 1.1.0 的 `--timeout` 覆盖完整 MCP 登录过程；高延迟认证环境应重新验收取消与超时。
- codemode 的 search/describe helper 明确标为 async；多个 text 输出与 console 分块更清楚。它们改善模型使用体验，不改变嵌套结果不独立落盘的设计。
- 单独二进制不再自动把启动目录 `.env*` 加入环境；若依赖过该行为应显式注入。当前 Node/pnpm CLI 不应被统一描述为因此失去配置。
- 托管安装更新只保留新版本和被替换的上一版；若需要更长回退窗口，须另保留版本/依赖记录。
- `server_busy`、Mistral error、Bedrock thinking 等重试/模型修复，以及长输入阶梯计价修复，按实际 API 路径受益。不能据此宣布 Cursor 等自定义 serializer 已自动正确。
- Herdr Markdown 链接可点击属于原生修复，不等于原生已实现 Herdr 工作流或完整状态消费协议。

### 11.7 本轮验证与未覆盖范围

本轮核对主仓仍为 `f48a91b`，CLI **0.87.1**；根扩展包 **1.0.2**、独立 Subagents **0.2.0**、Review **0.1.1**、Ollama **0.12.2**。fullscreen/dark、未配置 defaultTools、当前全局/项目无 mcp.json 也复核未变；没有重新全量审计所有外部工作副本。

为了避免旧 npm 包的 caret 依赖偷偷解析到新 SDK，本轮在隔离目录显式锁定并核实两套 **1.0.2 / 1.1.0** 的 Coding Agent、AI、Agent Core、TUI、Codemode、MCP、Telemetry、Chord 共八个包；不是只 pin CLI 包名。

| 检查 | 结果 |
|---|---|
| 16 包差分类型检查 | 1.0.2 **14/16**；1.1.0 **13/16**。Subagents/Review 各四条旧诊断逐字不变，Tool Display 新增五条同源测试 Terminal 诊断 |
| Fast 配方 | 采样同名键错误仍复现；32,000 字符样例的官方预算 7904→6761，本地保持 7904 |
| CLI/SDK 选择与注册门禁 | 两版纯函数/源码片段探针验证 MCP 保留、空集合、patterns、资源工具例外与 exposure 条件；不是端到端权限测试 |
| settled 顺序 | 纯探针确认原顺序未变，新字段传递取消事实；未启动真实 child 验收全部内部取消路径 |
| virtual/session | virtual 实现、SessionManager、virtual/session-format 文档、Jev 示例及三条模型请求方法对照一致；旧相关假设未被上游修复 |
| duration/padding/OSC | 精确 1.1.0 文档、类型及调用链审阅；确认 custom UI blocked 与 session identity 差距，未验证真实 Herdr 协议应答 |
| Azure | 精确 provider 源码确认 ID=`azure`，API 包含 `azure-openai-responses` 和 `openai-completions`；仓库旧符号定向检索无命中 |

未重跑首轮 22 入口 factory、旧版完整测试集、真实 provider/MCP/OAuth/TUI/Herdr、全部外部扩展及 active Plan 的完整集成回归。首轮数据仍归属 §7，1.0.2 数据仍归属 §10；**不把旧通过记录改写成 1.1.0 通过**。

本轮没有运行仓库包管理命令，没有修改扩展源代码/依赖声明/锁文件/配置或凭据，没有升级、提交或发布。仅在 `/var/tmp` 安装隔离 SDK、用现有编译器做 noEmit 检查，以及离线构造/比较；临时依赖在报告验收后清理。

### 11.8 最新来源

- [npm registry latest](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest)（动态端点；本轮响应为 1.1.0）
- [v1.0.3 Release](https://github.com/earendil-works/pi/releases/tag/v1.0.3)、[v1.0.4 Release](https://github.com/earendil-works/pi/releases/tag/v1.0.4)、[v1.1.0 Release](https://github.com/earendil-works/pi/releases/tag/v1.1.0)
- [Coding Agent changelog，v1.1.0](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/CHANGELOG.md)
- [工具选择与 MCP，v1.1.0 CLI 文档](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/cli.md#tools)
- [扩展/渲染契约，v1.1.0](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/extensions.md)
- [OSC program status，v1.1.0](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/terminal-setup.md#program-status)
- [分类、采样与模型配置，v1.1.0](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/models.md)
- [Codemode 图像与输出，v1.1.0](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/codemode.md)
- [Azure provider，v1.1.0](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/src/providers/azure.ts)

**现行建议：锁定 1.1.0 及其依赖图开展适配；增加测试 Terminal、工具选择、取消、耗时/留白/终端状态与 Fast 估算验收。保留大多数扩展，逐项去重，不期待新版本替本地 wrapper 和持久化设计自动补齐契约。**
