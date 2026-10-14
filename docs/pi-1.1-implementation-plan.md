# Pi 1.1.0 全扩展适配与待办整合计划

> **最新范围覆盖（2026-10-14 16:38）**：用户要求回撤 Context7、Plan 本轮变更，仅双语 README 标记停止维护并说明理由；不再迭代两包，不将其原生能力/真实接入作为本轮门槛。Ollama 非自有扩展，排除处理范围。下文相关 W5/P1/X1、17包版本及验收快照仅为历史，不能继续作为现行要求。执行编排 §0 记录回撤，真实安装、main和发布仍不操作。

状态：**用户已授权按执行编排开工及本地提交/集成；实际实施、返修与集成进度统一见执行编排 §0。七项存量、Antigravity、Herdr 命令体验、Search 登录识别/用量补报/配置串用修复仍不做；只支持 Pi 1.1+，Consult 的 Pi 上游公开 SDK 调用入口适配纳入。未升级用户宿主、未推送、未合并/关闭 GitHub 项目、未发布。**

范围快照：**2026-10-10 21:59（北京时间）**。仓库 `git@github.com:zhcsyncer/pi-extensions.git`，本地与远端 main 均为 `f48a91b8366174f2ece5d393e280641be87fbb70`。

本文件是现行实施入口；[升级审计](./pi-1.0-upgrade-review.md)保留版本差异、实测和历史证据，不再承担最终任务排序。包级详细规格按需打开，不必一次读完。[执行编排](./pi-extensions/pi-1.1-execution-plan.md)定义当前 session 调度、Herdr worktree 任务粒度、批次依赖和集成门槛，并在 §0 提供唯一进度表；W 编号是功能分组，不直接等于实施 session。

## 1. Goal 与交付范围

### 产品兼容性底线

- 在声明支持的 Pi 宿主版本上，**未启用 codemode 的用户必须能正常使用全部适用扩展**；直接调用是正式主路径，不是降级或临时兼容层。
- 支持 codemode 是增加可选调用方式。安装扩展不能擅自启用 codemode、修改用户 mode/defaultTools，或强制全部经脚本调用。
- **工作流工具的 model-only 是产品级调用边界，不只是作者本地偏好**：适用于所有用户，包括自行选择 codemode only 的用户；关闭 codemode 时仍可普通调用。用户文档须说明，实施前核验内部工具调用方，不能误伤既有运行时 API 复用。
- Context7 原生 MCP 与 codemode 独立：MCP direct 可以在完全没有 codemode 的会话中工作。未配置 Context7 不能阻断其他扩展。
- 不因作者的本地偏好关闭其他用户已有的 tool_search/模型配置；未完成验证的虚拟模型能力明确标注支持边界，不冒称完整兼容。

### 用户本地目标，不作为所有用户的强制默认

1. 用户选择启用 codemode、mode:on，与直接调用共存。普通 I/O/搜索可脚本编排，状态/交互/会话编排工具保持 model-only，现有权限不放宽。
2. 用户暂不使用虚拟模型、自动分流或独立 tool_search/deferred 流程。本轮不实现 router；不是产品替用户禁用这些宿主功能。
3. 用户本地接入官方 Context7 MCP direct，验证后只在该 profile 停用旧查询入口；旧 REST 扩展、包和 skill 暂时保留，不强迫其他用户迁移。凭据/配置变更仍需实施授权。

交付同时满足“普通模式继续好用”与“选择 codemode 的用户可安全编排”，不把本地启用步骤混入扩展安装行为。大多数扩展保留，官方机制用于收缩重复底层实现。

### 总 AC

- 本仓 **16 个子包/provider + 根 bundle** 均有明确处置及验收；外部实际资源也有兼容/排除门槛。
- 当前 **3 个开放 issue + 2 个开放 PR**、BACKLOG **12 个未完成条目**逐项追踪；完整覆盖不等于全部已批准本轮实施，存量选择见 §4。
- 必测“codemode 未加载/未启用”及“启用后混合调用”两条路径；未授权 child/规划/审查路径不因 MCP 自动接入而扩权。
- 聚合、历史、用量、取消、reload/恢复正确；不因原生功能存在就假定旧缺陷自动消失。
- 每项只有实现、对应验收及发布/处置条件满足后才能关闭；“有计划”“相关 PR 合并”不等于已解决。

### 范围边界

GitHub 清单仅针对本仓当前开放项目，含 draft（本次无 draft）。已关闭/合并条目只作关联证据；不自动扩张成整个 GitHub 账号所有仓库待办。

用户已确认按 **Pi 1.1.0 单基线**设计，最低宿主支持版本提升至 1.1.0，不兼容旧 Pi、不维护 0.87/1.1 双套私有补丁；发布说明须明确这一兼容性变化，具体包版本仍走最终版本 review。**支持底线与 npm peer range 分开**：宿主提供的模块按 Pi 打包规范声明为 `peerDependencies: "*"`，实际支持版本通过用户文档、测试矩阵和必要的宿主能力检查表达；开发/测试依赖仍精确锁定。无需 SDK 的 skill-only 包应移除无用依赖，而不是虚设 peer。

不自动启用已排除资源，不自动切 OAuth/账号，不引入未批准的 Plan relay、Pi Durable、分类路由或大范围新架构。不能为关闭一个待办擅自 fork/升级宿主到其他版本。

**已确认排除本轮：B01、B02、B04、B05、B10、B11、B12，七项存量全部不动。** 原 BACKLOG 保留，不勾选、不关闭；不为这些项启动实现、专项调查或新增验收承诺。其设计正文只留作后续参考。必要适配可以涉及同一文件，但不能顺手实现被冻结的目标；若已选任务确实依赖某项存量修复，先报告冲突并等待用户重新授权，不自动解冻。

## 2. 当前基线与证据边界

- **分析 VM** 的宿主为 **0.87.1**；主仓开发 SDK **0.86.1**。用户警告来自 **Mac 的另一套 Pi 环境，其版本/安装方式尚未确认**，不能把 VM 的版本代入 Mac，也不能只凭警告推断 Mac 的精确版本。上次精确 1.1.0 差分类型检查 **13/16**：Subagents/Review 各四条既有 disposition 诊断，Tool Display 五条同源测试 Terminal 诊断。
- 这些是审计结果，不是新实现通过记录。本轮只做源码/PR/契约审阅、公开资料核对与计划编写，未重跑测试、真实推理、MCP 或 TUI。
- 最新全局配置同时排除了 **bundle Plan 和 worktree Plan**；Junie 也已排除。不能再沿用旧报告“活动 Plan/Junie”描述。CLI/项目额外加载须在实施入口复核。
- main 是发布基线。`feat-plan-mode-subagent-explore` 的 relay 等差异单独审阅，未批准不合入；它的五条测试类型债务不自动算主仓升级回归。
- 根 bundle 自动加载 12 个入口；Herdr/Review 是独立加载项。Review 的 installed embedded 仍有 Subagents **0.2.0** 与 bundle **0.2.3** 分裂，必须验证真实安装解析。
- `BACKLOG.md` 已有用户修改，本轮不覆盖、不勾选；未跟踪审计文档及 docs 索引原改动也保留。

## 3. 全包处置矩阵

下表版本是源码基线，不是计划发布号。W 编号见 §5；七项存量已排除，其余按已选适配和 GitHub 范围推进。

| 包 | 当前版本 | 本轮适配 / 优化 | 工作包 |
|---|---:|---|---|
| `@zhcsyncer/pi-extensions` | 1.0.2 | 锁 SDK/实际安装树；更新 bundle/skill/pack 清单；整合验收与迁移说明 | W0/W11 |
| `pi-tool-display-intent` | 0.10.1 | 公共 renderer、完整语义包装、nested 投影；缓存、导航、普通用户样式开关；四个 GitHub 项目联合解决 | W3/W4 |
| `pi-subagents` | 0.2.3 | steering/取消/恢复；会话权限与 MCP 装配；费用水位；不做 B10–B12 | W1 |
| `pi-adversarial-review` | 0.1.1 | 统一执行核心；external/真实 installed embedded；只读与 format-repair 隔离 | W2 |
| `pi-plan-mode` | 0.3.1 | 适配 main 的审批/恢复/model-only；兼容旧 REST 与已核验 Context7 MCP 授权；不自动合入 relay | W2/W5 |
| `pi-todo` | 0.5.1 | model-only，保留 checkpoint 与周期不变量；多 runtime/branch 回归 | W2 |
| `pi-ask-user-question` | 0.1.2 | model-only，TUI/RPC/取消与 blocked 清理；新版键盘行为回归 | W2 |
| `pi-consult` | 0.1.1 | model-only、公开流 API；watchdog 层级、预算及 adoption/tree 恢复 | W2 |
| `pi-context7` | 0.1.1 | 旧扩展保留并做必要 1.1 兼容；本地改用官方 MCP；skill/授权/显示支持实际选择，不重写客户端或删包 | W5 |
| `pi-search-hub` | 1.0.0 | direct 与脚本结构化结果、必要兼容；保留搜索路由；登录识别/用量补报/配置串用修复暂缓 | W6 |
| `pi-fast-mode` | 0.2.1 | stream hook、官方采样优先级、3.5 字符/token 预算；缩小本地配方 | W6 |
| `pi-recap` | 0.4.3 | 保留固定模型侧路回顾；公开物理模型路径/取消/加载回归；明确旁路费用边界 | W6 |
| `pi-glance` | 0.9.2 | 独立 usage entry、theme.appearance；保留 working/Git/stash，不改大粘贴行为 | W7/W9 |
| `pi-meter` | 0.4.4 | 独立 usage、去重；Go 与 Antigravity 均按用户决定暂缓；不修旧 guest reload/空闲重试 | W7/W8 |
| `pi-herdr-companion` | 0.2.0 | model-only；保留会话/进程/BTW/blocked；检验 OSC 双源，不先删桥接 | W2/W11 |
| `pi-provider-cursor-ask` | 0.1.5 | system/tools 重放、真实流/取消与必要兼容；B02 标准 usage 恢复冻结 | W10 |
| `pi-provider-volcengine-agent-plan` | 0.4.1 | 正确 chat/compat 类型、tier/thinking/auth/错误回归；不因模型同名改计费渠道 | W6 |

上表除两个无 scope 的 provider 外，子包名称前缀均为 `@zhcsyncer/`。

### 外部与本地资源

| 资源 | 本轮处置 |
|---|---|
| Ollama Cloud 当前安装 0.13.0（旧快照 0.12.2） | 官方`fgrehm/pi-ollama-cloud` v0.13.0已通过Pi1.1离线兼容验收：两矩阵194/194、实际归档安装通过，未复现旧类型阻断，无产品迁移。源码及安装字节匹配，不改全局node_modules；真实服务/TTY未验 |
| Junie 1.3.2 + 用户修改 | 当前排除；保留工作副本。重新启用前在其独立仓验证 OAuth/Grazie/许可/余额；不能宣布已适配，也不阻塞未启用路径 |
| 全局 `herdr-agent-state.ts` v9 | 保留 session identity/socket 及 custom blocked；核验 OSC 支持与双源优先级，等价证据不足不删除 |
| worktree Plan | 默认不启用/不合入；若批准 relay，另审只读 ceiling、0.84 依赖及测试债务 |
| WTF / Context View / Figma / Moshi | 保持排除；不加载、不删除用户目录。需要重新启用时单独兼容验收 |
| pi-psql skill | 非 SDK 迁移对象，保持当前排除及 SQL 约定；不因版本升级删除 |

## 4. GitHub 与 BACKLOG 覆盖账

### 当前所有开放 GitHub 项目

两份 PR 的快照均为 MERGEABLE / BLOCKED，statusCheckRollup 为空；这不是 CI 已通过，也不能臆测具体阻塞原因。没有自动合并/关闭授权。

| 项目 | 重新判断 / 方案 | 关闭条件 |
|---|---|---|
| [#148](https://github.com/zhcsyncer/pi-extensions/issues/148) 历史预览卡顿 | 仍必要；预览与外壳两层缓存，不能以切 aggregate 代替 | W3 的失效/有界/100–300 工具基准与真实输入回归通过 |
| [#149](https://github.com/zhcsyncer/pi-extensions/pull/149) codemode 展示 | 不整包合入；保留意图，重做真实注册、三种数据来源、多层归属及预算 | 替代实现及 W3 联验通过，说明采纳范围、关联替代 PR 后再处置 |
| [#150](https://github.com/zhcsyncer/pi-extensions/pull/150) 导航标记 | 核心方案适用；与 #151 的路由/ownership 联合接线 | W4 在 1.1 的标记/导航/缓存/两布局回归通过后合入或等价摘取 |
| [#151](https://github.com/zhcsyncer/pi-extensions/issues/151) 普通用户框开关 | 保留默认样式，新增真正的 opt-out；steer 独立 | W4 开关两态、原生/其他 renderer 共存及 reload 通过 |
| [#152](https://github.com/zhcsyncer/pi-extensions/issues/152) Go + Antigravity 额度 | 用户已暂缓 Go 与 Antigravity，本轮不实施 | 两者保留未完成，不作为本轮门槛，也不关闭整条 issue |

PR head 固定为 #149 `10ce060373724518d35e2c1bd8ec863359625576`、#150 `3a84d176a2d78946f000cd39983d6ef44fe90334`。实施/合并前若 head 或 main 变化，重新审阅差异，不沿用旧“通过”结论。

### BACKLOG 的全部 12 个未完成条目

B 编号仅用于追踪，不修改原 BACKLOG，也不重复创建 GitHub issue。**B03/B06/B07/B08/B09 对应五个 GitHub 项目，仍在本轮，其中 B03 仅做 Go，Antigravity 已暂缓；其余七项已按用户决定全部冻结。** 冻结不是完成、删除或关闭，也不自动成为升级/发版阻塞。依赖冲突须另报，不能暗中扩大范围。

| ID | 原条目 | 工作包 / 处置 |
|---|---|---|
| B01 | Glance 大粘贴展开 | **本轮冻结**；不实施输入展开改造 |
| B02 | Cursor 标准 usage total | **本轮冻结**；不改标准总量合同、不启动上游能力工作 |
| B03 | Meter Go/Antigravity | W8 的 Go 与 Antigravity 均暂缓，关联 #152 保留未完成 |
| B04 | guest adapter 跨 reload | **本轮冻结**；不重构旧 host/注册表 |
| B05 | 失败 quota idle 重试 | **本轮冻结**；不新增空闲网络重试 |
| B06 | Tool Display 历史布局性能 | W3，关联 #148 |
| B07 | codemode aggregate/history | W3，重做 #149 实现而非照合 |
| B08 | 消息导航 | W4，联合 #150 |
| B09 | 普通用户消息 native opt-out | W4，关联 #151 |
| B10 | 子代理默认活动脱敏 | **本轮冻结**；保留当前展示行为 |
| B11 | upstream/fork 双加载警告 | **本轮冻结**；不新增该检测 |
| B12 | schedule/RPC invocation snapshot | **本轮冻结**；不扩展该链路/专项复核 |

### 七项冻结存量的背景（仅供后续参考）

- **B01 / 大粘贴可编辑**：粘贴大段/多行文字后，输入区仍拥挤或被宿主折成 paste marker。目标是直接展示更多正文供编辑，普通输入仍紧凑；属于体验增强，不是升级必需。源码复核指向 paste 行为，不只是 minRows 设置。
- **B02 / Cursor 的两种 token 数分开**：Cursor 的一轮累计消费与 Pi 判断“当前上下文占了多少”的数不是一回事。当前实现优先保护上下文安全，所以 totalTokens 合计不宜当真实累计消耗；已确认的分项/费用另保留，不是说服务器多扣钱。目标是恢复标准账单语义且不误触发压缩，需要通用上下文观察通道或可信逐次回执，不能只改显示公式。
- **B04 / reload 后额度来源不消失**：Cursor 等外部来源在启动时注册给 Meter；reload 顺序可能把注册留在旧实例，底栏变成 no quota window，重启才恢复。目标是任何加载顺序下 reload 后仍能识别来源。属于稳定性修复；BACKLOG 里的 cursor-api/auto 是旧称，当前实现已使用 cursor-include/other。
- **B05 / 暂时查询失败能自愈**：一次超时/刷新失败后底栏停在 unavailable，虽然网络已恢复，空闲时仍不重试。目标是失败快照到期自动重试，成功后停止额外网络请求；不把健康状态改为持续轮询。它与 B04 的“来源注册丢失”不是同一故障。
- **B10 / 子代理默认摘要脱敏**：子代理原始命令、URL 参数可能含 token/密码，默认活动区直接显示会进入截图/日志。目标是默认安全摘要、明确展开再看完整参数；不是已经完成的 ANSI 控制字符清理。属于显示隐私防护，不是 1.1 新回归。
- **B11 / 上游与 fork 双加载警告**：用户同时装 upstream pi-subagents 与本 fork 时可能重复注册同名工具/界面。目标是清楚指出冲突，不崩溃、不自动卸载，也不是做“两个版本同时正常运行”的兼容层。属于安装防误用。
- **B12 / 定时或 RPC 子代理的模型标签**：普通 Agent 调用有模型/思考档快照，其他启动路径历史上可能缺少，导致查结果时标签为空/不准。目标是启动→归档→恢复显示一致，不新增定时/RPC 功能。现有 manager 已有部分 fallback，应先复现剩余缺口，不能重复实现已有能力。

以上背景仅供以后重新评估，不是本轮任务或新实测。用户已明确七项全部不动，此前优先级建议不再作为本轮执行依据。

已勾选的 ANSI 清理、视觉风格收敛、/tools 改名、双语说明及 docs-only validate 等不重新立项；作为回归约束保留。新普通消息 ownership 开关不恢复已移除的多主题配置。

## 5. 实施工作包与依赖

下列工作包已排除七项存量：W1 不带入 B10–B12，W7 不带入 B04/B05，W9 不改 B01，W10 不处理 B02。包级文档的冻结段落和对应专项测试不是执行入口，也不作本轮发布门槛；必要兼容、现有测试及不引入新回归仍必验。以下图表示功能依赖，不是直接派发单元；实际按[执行编排](./pi-extensions/pi-1.1-execution-plan.md)拆成独立验收任务，默认最多三个实施 session 并行，共享写路径串行整合。

```text
W0 基线/来源/测试环境
 ├─ W1 子会话权限、终态与恢复 → W2 工作流/Review
 ├─ W3 公共渲染→缓存→nested投影
 ├─ W4 用户样式/导航 ───────────┘（同一显示整合负责人）
 ├─ W6 普通 provider/Fast/Search/Recap
 ├─ W7 新SDK用量记账
 ├─ W8 新额度来源（用户暂缓，不作为本轮门槛）
 ├─ W9 主题与既有输入回归（不改大粘贴）
 └─ W10 Cursor本地重放/兼容（不改标准usage）
W5 本地官方MCP接入可独立验证；child/Plan/显示联验依赖 W1/W2/W3
W2…W10各自验收 → W11 整合、发布review与宿主切换
```

### W0：冻结 SDK、实际来源和验证环境

- 精确锁 1.1.0 的 Coding Agent/AI/Agent Core/TUI/Codemode/MCP/Telemetry/Chord 及完整依赖图；npm 的 CLI 版本号不锁传递依赖。
- 按每包真实使用更新 dev/peer、workspace overrides、pack/smoke 配置；只移除已无需要的旧修补，不一刀删除发布龄/build 安全策略。
- **修复用户启动时报告的 host-provided dependency 警告**：根 package.json 当前将 `@sinclair/typebox` 与 `typebox` 放在 dependencies。将实际使用的宿主提供模块及兼容别名移到 `peerDependencies: "*"`，不打包私有副本；开发所需版本留在 devDependencies。对根包、全部子包及发布产物检查同类问题，按宿主提供名单处理，不把所有第三方依赖一刀移为 peer。
- 验收不只看 manifest：用 Pi 管理的全新安装和升级后的安装树验证，不自动安装宿主 peers、不残留会绕过 loader 的私有运行时副本；本地工作树的依赖树由项目负责，另测其加载。该警告是声明风险，不等于已经证明重复实例实际加载。当前现场未确认用户宿主版本及检测首次出现版本，不把警告机制冒称为 1.1.0 新增。
- 为真实 loader、SDK child、MCP 假 transport、TUI 建隔离 agentDir；不加载用户 auth/项目脚本，不允许测试向真实服务请求。
- 补 Terminal 测试 adapter；复核实际 standalone/bundle/runtime 解析。主仓16包检查要完整覆盖，根 `pnpm check` 不替代未被其调用的包级检查。

**出口**：可重复的 1.1 测试环境和实际资源来源表；已知失败逐项归属。进入阶段不要求尚未实施的修复已通过，最终不得携带这些失败关闭 W11。

### W1/W2：运行时与工作流

详见[运行时规格](./pi-subagents/pi-1.1-runtime-plan.md)。先修权威权限 hook、注册/连接范围、真实回执和恢复，再装配 child MCP/codemode；随后统一 Review backend 与轻量 model-only 工具。

**出口**：普通模式及启用后的顶层/nested 同权限，隔离审查没有 MCP/codemode，main planning 不扩权；必要恢复/费用回归通过，不涉及 B10–B12 目标。

### W3/W4：显示层与四个 GitHub 项目

详见[Tool Display 规格](./pi-tool-display-intent/pi-1.1-integration-plan.md)。采用官方 renderer，但保留必要语义装饰；有界缓存与输出先于新的嵌套详情；#150/#151 共用消息路由与 marker ownership。

**出口**：没有失主的 nested 行、无重复账/无界布局，导航和 opt-out 正确；真实注册测试而非可变 ToolInfo mock。

### W5：本地接入官方 Context7 MCP，旧扩展保留

详见[接入规格](./pi-context7/native-mcp-migration.md)。Pi 原生连接官方服务，核验实际声明与认证后，仅在用户自己的 profile 停用旧 Context7 查询入口，保留包/代码/配置/skill。撤回删除 REST 层、依赖清理、skill-only 化和修改根 bundle 默认入口的方案，不再实现 MCP 客户端包装。

旧扩展继续提供普通使用；共享 skill、Plan 和 SDK child 按实际选择兼容两种接入，不把原工具名全部替换成 MCP 名称。本地配置无需等待旧包退役；运行时和统一显示则联合验收。

**出口**：旧扩展用户无需 MCP/codemode 也正常；本地官方 MCP 可直接调用并可选脚本调用；授权 child 可用、isolated 不扩权；该 profile 没有重复入口，旧历史可读且旧实现仍可回退。

### W6：Fast、Search Hub、Recap、Volcengine 的普通路径

- **Fast**：不把模型默认采样提前伪装成请求覆盖；尽量将三层合并交还官方 adapter。同步 provider stream hook、完整 options 与 3.5 字符/token 估算。先验证公开 helper 是否 loader-safe；确无可复用入口才保留单一薄配方并与真实 SDK 对照，不添加脆弱绝对路径导入。
- **Search Hub**：保留 routing/combine/RRF/reader 与原有认证/计费行为；增加脚本友好的 outputSchema/structuredContent，模型文本预览保持原体验。用户已明确暂不做新登录识别/认证分流、hosted usage 补报、跨会话配置串用修复，不将这些旧问题列为本轮验收门槛；升级或已选脚本能力若与之形成硬依赖，报告冲突，不自动解冻。必要兼容与取消回归不得引入新副作用或静默切换付费 key/账号。
- **Recap**：保留物理模型侧路回顾、命名/标题及取消行为；不为当前不采用的虚拟模型重构。不把 raw complete 的旁路开销声称已被宿主自动记账，保留明确费用边界。
- **Volcengine**：复用正确 chat/compat 类型，验证 tier/thinking/headers、取消和错误；订阅渠道与同名模型 API-key 渠道不互换。未列入本轮的额度自动刷新提案不顺带实施。

**出口**：Fast 官方离线 fixture 一致；搜索直接/脚本结果与路由一致且无计费渠道暗切；物理 provider 流式/取消/真实授权验收完成。

### W7/W8：SDK 账本与新增额度来源 #152

详见[Meter 规格](./pi-meter/pi-1.1-quota-plan.md)。本轮保留独立usage补账/去重；B04注册表修复与B05空闲重试明确不做。**用户已暂缓Go与Antigravity，两者均不作为本轮验收或发布门槛。** Go当前schema尚未确认，未访问真实额度；不以历史格式猜测当前响应，也不为此解冻旧机制。

**出口**：账本适配正确，旧来源没有新增回归，不承诺修复原有reload/空闲重试缺陷。#152整体保留未完成，不以未知/占位值冒充支持。

### W9：Glance 主题与既有输入回归

本轮只做 theme.appearance、必要显示兼容及原输入/stash 行为回归；工具完成耗时不替代整轮 working row。[输入规格](./pi-glance/pi-1.1-input-plan.md)中的 B01 大粘贴方案冻结，不重构 paste 路径。

**出口**：主题与 SDK 适配正确，已有编辑/暂存体验无新增回归；不以大粘贴增强是否完成验收本轮。

### W10：Cursor 本地重放与必要兼容

详见[Cursor 规格](./pi-provider-cursor-ask/pi-1.1-adaptation-plan.md)。本轮只处理 transcript 重放及真实流/取消等必要兼容，保留当前计费/上下文安全策略；不为 B02 发起宿主能力提案、回执研究或契约改造，也不借 producer 适配实施 B04。

**出口**：1.1 本地兼容与重放回归通过，没有新增上下文风险；B02 继续留在 BACKLOG，不是本轮阻塞。

### W11：整合验收、PR/issue 处置、发布与切换

- 执行 §6 的真实集成矩阵，检查全部包、根 pack、standalone 安装、资源过滤和历史恢复。
- 对本轮选中项目逐项更新验收证据，再经授权处置 GitHub/BACKLOG；未选项目保留，不能默认作为本轮必做或擅自关闭。
- 依 `RELEASING.md` 添加分语义 changesets，列出每个实际更新包的**当前版本、bump、目标版本**交用户 review。这里不预生成版本、不直接发布、不推 tag。
- bundled 子包变化包含根包；独立 Review/两个 provider 不无故带动根包；保持双语用户说明、pack 内容与说明一致。
- 经确认后走 changeset 合入→自动 version PR→review/合并→Actions 发布。任何非 main 分支推送前 fetch origin/main，必要时 rebase。
- 宿主升级/安装方式迁移另获确认；记录旧依赖/配置与回退方法，重启验收，不把 npm 热替换当保证。已有排除项保持不变。

## 6. 共同 Contract 与验收矩阵

T0 为预算/费用精确数值；T1 为授权/状态/恢复/缓存等规则；T2 为真实 SDK/loader/UI/transport 集成。纯装饰不凑单测，关键行为测试不要 mock 自证；含 T0/T1 的工作包在编码前完成测试设计，并让独立测试编写者按合同而非实现补用例。

| 合同 | 必测行为 |
|---|---|
| 可选接入 | 不加载/不启用 codemode 时普通工具、工作流、渲染和恢复正常；安装不改用户 defaultTools/mode；MCP direct 无脚本可用；打开旧 codemode 历史不自动启用或重执行 |
| 工具权限 | direct data 可直接/嵌套；model-only 在普通模式直接可用、嵌套拒绝；顶层与多层 nested 的禁用动作均零副作用；MCP 连接/注册/执行分别受控 |
| SDK/实际安装 | 宿主模块 peer `*`、发布不夹带其运行时、无声明警告；全新/升级安装与本地工作树验证真实模块归属，开发副本不与宿主混用；factories 按会话配置/授权装配，本地方案不默认引入 tool_search、也不关闭用户已有配置；late MCP/pin 不扩权；Review external 与 npm 安装 embedded 都测，不仅 workspace alias |
| schema/data | Bash 结构化成功/非零退出、context/sampling 不丢；codemode raw-JS grammar 不变；Search/MCP 文本与结构化结果分别正确 |
| Fast T0 | 32k 字符单 user、context20k/max16k 的官方预算 6761；默认温度1/high0.3/top_k20 得0.3/20；显式请求0.2胜出，off及无默认值也测 |
| 账本 T0 | assistant/outer tool/usage 的精确总和；nested 不双加；父 Agent rollup/子账本恰好一次；缺回执不等于确认零 |
| 生命周期 | queued/handled/rejected；内部/外部 abort；实际终态后清理；合法 retain-none；损坏恢复不静默新建；branch/reload 无串态 |
| 显示 | individual/aggregate、实时/结束/历史/HTML、深层/不完整记录、outputPad0/1、旧 duration、错误/展开有界 |
| 导航/性能 | 宿主 marker 保真，普通样式开关不改变 steer；100/300 历史成本与输入延迟分开测；resize/主题/cache失效 |
| 编辑 | 已有输入/粘贴/stash、窄屏/补全/鼠标无新增回归，Home/End 与消息导航不混淆；不要求实现 B01 |
| 配额 | 既有来源必要兼容回归（含Ollama已有usage）；Go/Antigravity按用户决定暂缓，不新增来源、不要求修B04/B05，也不以合成响应宣称真实额度已验 |
| 真实授权集成 | Context7、实际使用 provider、Ollama/Herdr/BTW；隔离 profile、不读取无关凭据，不在 CI 调付费服务 |
| 发布 | 全16包适用检查＋root check/pack；精确依赖图、双语/技能入口、无悬空旧工具、no-op factory 不算活动路径通过 |

## 7. 真实阻塞、可并行项与“完备”的含义

本计划已经**覆盖所有当前项目并给出方案/验收/依赖**，但不能声称每项已经具备无条件开工或结案所需的外部事实。

| 门槛 | 下一步 / 不能做什么 |
|---|---|
| G1：Antigravity（已暂缓） | 本轮不调查、不实现，不作为发布阻塞；仅完成 Go 不关闭整个 #152，重新启动须另获授权 |
| G2：Cursor context/billing 分离（冻结记录） | B02 已排除本轮；保留已知限制，不启动该上游/协议工作，不作为发布阻塞 |
| G3：Context7 本地接入 | 经授权握手验证名字/schema与现有账号，再仅于该 profile 停旧入口；保留旧包/代码，不覆盖配置冲突或把候选名当已验证 |
| G4：被排除工作树/外部资源 | 默认保持排除；main 适配不自动批准 Plan relay/Junie 开启或覆盖用户修改 |

G1 按用户决定暂缓，G2 随 B02 冻结，均不启动调查。其余已选项目到发布时仍未闭合，须明确报告并由用户确认是否分阶段发布；七项冻结存量与 Antigravity 均不阻塞本轮升级。若 #152 等任务与冻结范围冲突，先报告并暂缓受影响部分，不能擅自降低验收、解冻或关闭。

虚拟模型路由、selected/physical 身份、虚拟 quota/恢复等旧审计条件风险明确不在本轮功能范围；没有被标成已修复。以后采用虚拟模型再重新打开。

### 实施前还需收口的范围与验证门槛

- **按理由归类，而非把审计发现都当必修**：每个实现单元标为 1.1 必要兼容、已选能力前置/优化、五个 GitHub 项目、或未批准的独立旧债。七项 BACKLOG 存量已经冻结，不重新提请选择；这里需要清理的是未列入那七项、却被审计带入执行段落的内容。用户已进一步确认 Herdr 子命令补全/空调用菜单与 Search Hub 登录识别/用量补报/配置串用修复本轮不做；若与必要兼容形成硬依赖须报告冲突，不自动解冻。用户已确认将 Consult 改用 Pi 上游公开 SDK 调用入口纳入适配；必须保留原模型/账号/订阅渠道、认证附带字段、取消与无工具边界，不能把删除内部探测等同认证兼容已完成。此处“公开”指 Pi 的扩展 SDK，不是改接模型厂商 HTTP API；接口等价性在其任务中验证。纳入计划不等于已经授权启动代码实施。Search 的脚本结构化结果、独立 usage entry、Cursor 重放须分别核验与已选脚本能力/1.1 新记录及动态上下文的关系，不能笼统归成必做，也不能未经核实全部删去。本条范围门槛优先于下层文档中的直接实施措辞；尚未归类的独立旧债/顺手优化暂不进入实施，已选择的公共 renderer 优化保持不变。
- **子代理能力不得静默缩水**：当前方案仍是按授权接入原生 MCP/codemode。改为 child 无 Context7 或显式使用旧 REST 都属于另一种产品取舍，不能以“简化架构”为由自动替换；若希望缩减，先确认主会话与 child 各自应有的能力。
- **区分闭单与发布**：用户已确认本轮不做 Antigravity，只验收 #152 的 Go 部分；无需再为暂缓 Antigravity 重复征求范围确认。Go 内置来源与既有刷新机制优先评估，不关闭未完成诉求。实际发版仍须版本 review 与发布授权。
- **分离机器验收与真实终端验收**：组件缓存/数值/导航标记合同可进 CI；真实输入延迟、fullscreen 按键及终端支持需标为脚本化或人工验收，记录宿主版本、安装方式、OS/终端、layout、历史规模和前后结果。VM 结果不代替 Mac，不能把人工步骤写成已自动完成的 CI 门槛。
- **最低支持已确认，发布号仍需 review**：用户已确认最低支持 Pi 1.1.0，不兼容旧 Pi；peer `*` 不负责拦截旧宿主。核验必要宿主能力的明确失败提示，不添加双版本分支；支持底线变化与工具调用限制的发布级别在版本 review 中列明。Mac 当前版本/安装方式仅是切换前的环境核实，不再作为是否兼容旧版的待决项。

### 已核对、不能据此扩大改造的两点

- 仓内只有内置 Bash 自动添加 `displaySummary`，通用 helper 对外导出不等于其他工具已接入。codemode 脚本无需为此额外填字段；现有 withDisplaySummary.prepareArguments 已能补 fallback，没有已确认的缺字段故障。保留现有机制，不扩大字段范围、不改为可选；精确 1.1 真实 loader 的直接/nested 缺字段调用仍须验收，不能把现有 helper 测试或来源未完整核验的缓存源码当成全链路已通过。
- 精确 1.1 的 Node aliases 和 bundled virtualModules 均把 `@sinclair/typebox` 映射到宿主 typebox。依赖声明仍须修，但不以旧包名为由全仓迁移 import；真实安装/编译加载路径仍单独验证。

## 8. 实施与文档纪律

本轮已授权按确认范围实施及任务分支本地 commit、专用集成分支 cherry-pick；不包含 push、合 main、关闭 issue、发布或真实账号配置变更。已确认的纳入/冻结决定保持生效。用户已选择**当前 session 作为唯一调度者并负责集成，每个任务在 Herdr worktree 的独立 Pi session 中实施**；不另开调度 session。当前 session 维护执行编排中的唯一进度表，worker 只回报不改总表；代码在独立集成 worktree 汇合，原工作区仅更新获准的计划/进度文档。按[执行编排](./pi-extensions/pi-1.1-execution-plan.md)执行；每个任务仍须具备可执行合同及测试设计后派发，不因整体开工而跳过任务验收或扩大范围。先固定当前未提交的计划快照，不能假设新 worktree 能看到它；不夹带用户原有改动。调度者唯一维护全局状态，Tool Display/runtime 各自同负责人串行，Glance 用量与主题合为同一任务；不在当前含用户改动的工作区并行实施。

实施中每个工作包保留 Goal/AC/Design/Contract/Test Impact 与实际验证记录；稳定后按仓库规则蒸馏。文档只在真实验收后更新“已落地”状态；不以类型通过代替真实认证/UI/恢复验证。

依据：上述六份包级规格、[升级审计](./pi-1.0-upgrade-review.md)、[BACKLOG](../BACKLOG.md)、[发布规则](../RELEASING.md)、精确 [Pi v1.1.0 extensions](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/extensions.md) / [SDK](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/sdk.md)。宿主依赖声明警告另参照用户现场日志与[当前 Pi 打包规范](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md#declare-dependencies)；该动态来源不改变本计划的 1.1.0 目标。
